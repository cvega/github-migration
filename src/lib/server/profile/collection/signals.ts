import type { graphql } from "@octokit/graphql";
import { countByPagination, type GitHubClient } from "$lib/server/core/github";
import type { DiscoveredRepo, RepoSignals } from "../types";

interface CountsNode {
  issues: { totalCount: number };
  pullRequests: { totalCount: number };
  branches: { totalCount: number };
  tags: { totalCount: number };
  releases: { totalCount: number };
  discussions: { totalCount: number };
  projectsV2: { totalCount: number };
  environments: { totalCount: number };
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  packages: { totalCount: number };
  rulesets: { totalCount: number } | null;
  branchProtectionRules: { totalCount: number };
}
interface RuleNode {
  allowsForcePushes: boolean;
  requiresDeployments: boolean;
  lockBranch: boolean;
  blocksCreations: boolean;
  requireLastPushApproval: boolean;
  bypassForcePushAllowances: { totalCount: number };
  bypassPullRequestAllowances: { totalCount: number };
}
interface DetailsNode {
  gitattributes: { text: string | null } | null;
  workflows: { entries: { name: string }[] } | null;
  releases?: { nodes: { releaseAssets: { nodes: { size: number }[] } }[] };
  branchProtectionRules: { nodes: RuleNode[] };
}
export interface RepoDetails {
  nameWithOwner: string;
  branchProtectionRulesUsingUnmigratedFeatures: number;
  usesLfs: boolean;
  workflowFileCount: number;
  releaseAssetBytes: number;
}
export interface RepoRestSignals {
  webhooksCount: number;
  hasCodeScanningAlerts: boolean;
  collaboratorsCount: number;
  tagProtectionCount: number;
}

const COUNTS = `fragment Counts on Repository {
 issues { totalCount } pullRequests { totalCount }
 branches: refs(refPrefix: "refs/heads/", first: 1) { totalCount }
 tags: refs(refPrefix: "refs/tags/", first: 1) { totalCount }
 releases { totalCount } discussions { totalCount } projectsV2 { totalCount }
 environments { totalCount } stargazerCount forkCount watchers { totalCount }
 packages { totalCount } rulesets(first: 1, includeParents: false) { totalCount }
 branchProtectionRules(first: 1) { totalCount }
}`;
function detailsFragment(scanReleases: boolean): string {
  const releases = scanReleases
    ? "releases(first: 50) { nodes { releaseAssets(first: 30) { nodes { size } } } }"
    : "";
  return `fragment Details on Repository {
 gitattributes: object(expression: "HEAD:.gitattributes") { ... on Blob { text } }
 workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
 ${releases}
 branchProtectionRules(first: $rules) { nodes { allowsForcePushes requiresDeployments lockBranch blocksCreations requireLastPushApproval bypassForcePushAllowances { totalCount } bypassPullRequestAllowances { totalCount } } }
}`;
}
function query(count: number, fragmentName: string, fragment: string, rules: boolean): string {
  const variables = rules ? ["$rules: Int!"] : [];
  const fields: string[] = [];
  for (let index = 0; index < count; index += 1) {
    variables.push(`$o${index}: String!`, `$n${index}: String!`);
    fields.push(
      `r${index}: repository(owner: $o${index}, name: $n${index}) { ...${fragmentName} }`,
    );
  }
  return `query batch(${variables.join(", ")}) {\n${fields.join("\n")}\n}\n${fragment}`;
}
function ownerOf(repo: DiscoveredRepo): string {
  const slash = repo.nameWithOwner.indexOf("/");
  return slash > 0 ? repo.nameWithOwner.slice(0, slash) : repo.nameWithOwner;
}
function signals(repo: DiscoveredRepo, node: CountsNode | null): RepoSignals {
  return {
    ...repo,
    commitsCount: 0,
    releaseAssetBytes: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    usesLfs: false,
    workflowFileCount: 0,
    webhooksCount: 0,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
    issuesCount: node?.issues.totalCount ?? 0,
    pullRequestsCount: node?.pullRequests.totalCount ?? 0,
    branchesCount: node?.branches.totalCount ?? 0,
    tagsCount: node?.tags.totalCount ?? 0,
    releasesCount: node?.releases.totalCount ?? 0,
    discussionsCount: node?.discussions.totalCount ?? 0,
    projectsV2Count: node?.projectsV2.totalCount ?? 0,
    environmentsCount: node?.environments.totalCount ?? 0,
    stargazerCount: node?.stargazerCount ?? 0,
    forkCount: node?.forkCount ?? 0,
    watcherCount: node?.watchers.totalCount ?? 0,
    packagesCount: node?.packages.totalCount ?? 0,
    rulesetCount: node?.rulesets?.totalCount ?? 0,
    branchProtectionRuleCount: node?.branchProtectionRules.totalCount ?? 0,
  };
}
export function baseSignals(repo: DiscoveredRepo): RepoSignals {
  return signals(repo, null);
}
function details(repo: DiscoveredRepo, node: DetailsNode | null): RepoDetails {
  const usesUnmigrated = (rule: RuleNode) =>
    rule.allowsForcePushes ||
    rule.requiresDeployments ||
    rule.lockBranch ||
    rule.blocksCreations ||
    rule.requireLastPushApproval ||
    rule.bypassForcePushAllowances.totalCount > 0 ||
    rule.bypassPullRequestAllowances.totalCount > 0;
  let releaseAssetBytes = 0;
  for (const release of node?.releases?.nodes ?? [])
    for (const asset of release.releaseAssets.nodes) releaseAssetBytes += asset.size;
  return {
    nameWithOwner: repo.nameWithOwner,
    branchProtectionRulesUsingUnmigratedFeatures:
      node?.branchProtectionRules.nodes.filter(usesUnmigrated).length ?? 0,
    usesLfs: /filter=lfs/.test(node?.gitattributes?.text ?? ""),
    workflowFileCount:
      node?.workflows?.entries.filter((entry) => /\.ya?ml$/i.test(entry.name)).length ?? 0,
    releaseAssetBytes,
  };
}
function timeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; message?: string };
  return (
    value.status === 502 ||
    value.status === 504 ||
    (typeof value.message === "string" &&
      /timeout|timed out|executing your query|respond to your request in time/i.test(value.message))
  );
}
function partial(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}
async function augment<TNode, TOut>(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
  build: (count: number) => string,
  map: (repo: DiscoveredRepo, node: TNode | null) => TOut,
  extra: Record<string, number> = {},
): Promise<TOut[]> {
  if (repos.length === 0) return [];
  const variables: Record<string, string | number> = { ...extra };
  repos.forEach((repo, index) => {
    variables[`o${index}`] = ownerOf(repo);
    variables[`n${index}`] = repo.name;
  });
  let data: Record<string, TNode | null>;
  try {
    data = await gql<Record<string, TNode | null>>(build(repos.length), variables);
  } catch (error) {
    if (timeout(error)) {
      if (repos.length === 1) return [map(repos[0] as DiscoveredRepo, null)];
      const middle = Math.ceil(repos.length / 2);
      return [
        ...(await augment(gql, repos.slice(0, middle), build, map, extra)),
        ...(await augment(gql, repos.slice(middle), build, map, extra)),
      ];
    }
    const recovered = partial(error);
    if (!recovered) throw error;
    data = recovered as Record<string, TNode | null>;
  }
  return repos.map((repo, index) => map(repo, data[`r${index}`] ?? null));
}
export function augmentRepoCounts(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
): Promise<RepoSignals[]> {
  return augment<CountsNode, RepoSignals>(
    gql,
    repos,
    (count) => query(count, "Counts", COUNTS, false),
    signals,
  );
}
export function augmentRepoDetails(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
  options: { scanReleases?: boolean } = {},
): Promise<RepoDetails[]> {
  const scan = options.scanReleases ?? true;
  return augment<DetailsNode, RepoDetails>(
    gql,
    repos,
    (count) => query(count, "Details", detailsFragment(scan), true),
    details,
    { rules: 50 },
  );
}
async function best<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}
export async function gatherRepoRestSignals(
  rest: GitHubClient,
  repo: DiscoveredRepo,
): Promise<RepoRestSignals> {
  const slash = repo.nameWithOwner.indexOf("/");
  if (slash <= 0)
    return {
      webhooksCount: 0,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 0,
      tagProtectionCount: 0,
    };
  const params = {
    owner: repo.nameWithOwner.slice(0, slash),
    repo: repo.nameWithOwner.slice(slash + 1),
  };
  const [webhooksCount, hasCodeScanningAlerts, collaboratorsCount, tagProtectionCount] =
    await Promise.all([
      best(() => countByPagination(rest, "GET /repos/{owner}/{repo}/hooks", params), 0),
      best(async () => {
        const data = (
          await rest.request("GET /repos/{owner}/{repo}/code-scanning/alerts", {
            ...params,
            per_page: 1,
          })
        ).data;
        return Array.isArray(data) && data.length > 0;
      }, false),
      best(
        () =>
          countByPagination(rest, "GET /repos/{owner}/{repo}/collaborators", {
            ...params,
            affiliation: "direct",
          }),
        0,
      ),
      best(async () => {
        const data = (await rest.request("GET /repos/{owner}/{repo}/tags/protection", params)).data;
        return Array.isArray(data) ? data.length : 0;
      }, 0),
    ]);
  return { webhooksCount, hasCodeScanningAlerts, collaboratorsCount, tagProtectionCount };
}
