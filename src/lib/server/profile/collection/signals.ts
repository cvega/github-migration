import type { graphql } from "@octokit/graphql";
import { z } from "zod";
import { countByPagination, type GitHubClient } from "$lib/server/core/github";
import type { DiscoveredRepo, RepoSignals } from "../types";

const count = z.number().int().nonnegative();
const connection = z.object({ totalCount: count });
const countsNode = z.object({
  isEmpty: z.boolean(),
  issues: connection,
  pullRequests: connection,
  branches: connection,
  tags: connection,
  releases: connection,
  discussions: connection,
  projectsV2: connection,
  environments: connection,
  stargazerCount: count,
  forkCount: count,
  watchers: connection,
  packages: connection,
  rulesets: connection,
  branchProtectionRules: connection,
});
const ruleSchema = z.object({
  allowsForcePushes: z.boolean(),
  requiresDeployments: z.boolean(),
  lockBranch: z.boolean(),
  blocksCreations: z.boolean(),
  requireLastPushApproval: z.boolean(),
  bypassForcePushAllowances: connection,
  bypassPullRequestAllowances: connection,
});
const detailsNode = z.object({
  gitattributes: z.object({ text: z.string() }).nullable(),
  workflows: z.object({ entries: z.array(z.object({ name: z.string() })) }).nullable(),
  branchProtectionRules: z.object({ nodes: z.array(ruleSchema) }),
});
const releaseNode = z.object({
  nodes: z.array(
    z.object({ releaseAssets: z.object({ nodes: z.array(z.object({ size: count })) }) }),
  ),
});
export interface RepoDetails {
  nameWithOwner: string;
  branchProtectionRulesUsingUnmigratedFeatures: number;
  usesLfs: boolean;
  workflowFileCount: number;
  releaseAssetBytes: number;
}
export type RepoRestSignals = Pick<
  RepoSignals,
  "webhooksCount" | "hasCodeScanningAlerts" | "collaboratorsCount" | "tagProtectionCount"
>;

const COUNTS = `fragment Counts on Repository {
 isEmpty issues { totalCount } pullRequests { totalCount }
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
type RepoCounts = Omit<
  RepoSignals,
  keyof RepoRestSignals | Exclude<keyof RepoDetails, "nameWithOwner"> | "commitsCount"
>;

function signals(repo: DiscoveredRepo, node: z.infer<typeof countsNode>): RepoCounts {
  return {
    ...repo,
    isEmpty: node.isEmpty,
    issuesCount: node.issues.totalCount,
    pullRequestsCount: node.pullRequests.totalCount,
    branchesCount: node.branches.totalCount,
    tagsCount: node.tags.totalCount,
    releasesCount: node.releases.totalCount,
    discussionsCount: node.discussions.totalCount,
    projectsV2Count: node.projectsV2.totalCount,
    environmentsCount: node.environments.totalCount,
    stargazerCount: node.stargazerCount,
    forkCount: node.forkCount,
    watcherCount: node.watchers.totalCount,
    packagesCount: node.packages.totalCount,
    rulesetCount: node.rulesets.totalCount,
    branchProtectionRuleCount: node.branchProtectionRules.totalCount,
  };
}
function details(
  repo: DiscoveredRepo,
  node: z.infer<typeof detailsNode>,
  releases?: z.infer<typeof releaseNode>,
): RepoDetails {
  const usesUnmigrated = (rule: z.infer<typeof ruleSchema>) =>
    rule.allowsForcePushes ||
    rule.requiresDeployments ||
    rule.lockBranch ||
    rule.blocksCreations ||
    rule.requireLastPushApproval ||
    rule.bypassForcePushAllowances.totalCount > 0 ||
    rule.bypassPullRequestAllowances.totalCount > 0;
  let releaseAssetBytes = 0;
  for (const release of releases?.nodes ?? [])
    for (const asset of release.releaseAssets.nodes) releaseAssetBytes += asset.size;
  return {
    nameWithOwner: repo.nameWithOwner,
    branchProtectionRulesUsingUnmigratedFeatures:
      node.branchProtectionRules.nodes.filter(usesUnmigrated).length,
    usesLfs: /filter=lfs/.test(node.gitattributes?.text ?? ""),
    workflowFileCount:
      node.workflows?.entries.filter((entry) => /\.ya?ml$/i.test(entry.name)).length ?? 0,
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
async function augment<TOut>(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
  build: (count: number) => string,
  map: (repo: DiscoveredRepo, node: unknown) => TOut,
  extra: Record<string, number> = {},
): Promise<TOut[]> {
  if (repos.length === 0) return [];
  const variables: Record<string, string | number> = { ...extra };
  repos.forEach((repo, index) => {
    variables[`o${index}`] = ownerOf(repo);
    variables[`n${index}`] = repo.name;
  });
  let data: Record<string, unknown>;
  try {
    data = await gql<Record<string, unknown>>(build(repos.length), variables);
  } catch (error) {
    if (timeout(error) && repos.length > 1) {
      const middle = Math.ceil(repos.length / 2);
      return [
        ...(await augment(gql, repos.slice(0, middle), build, map, extra)),
        ...(await augment(gql, repos.slice(middle), build, map, extra)),
      ];
    }
    throw error;
  }
  return repos.map((repo, index) => {
    try {
      return map(repo, data?.[`r${index}`]);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      const field = error.issues[0]?.path.join(".");
      throw new Error(
        `Incomplete GraphQL data for ${repo.nameWithOwner}${field ? `: ${field}` : ""}`,
      );
    }
  });
}
export function augmentRepoCounts(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
): Promise<RepoCounts[]> {
  return augment(
    gql,
    repos,
    (count) => query(count, "Counts", COUNTS, false),
    (repo, node) => signals(repo, countsNode.parse(node)),
  );
}
export function augmentRepoDetails(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
  options: { scanReleases?: boolean } = {},
): Promise<RepoDetails[]> {
  const scan = options.scanReleases ?? true;
  const schema = detailsNode.extend({ releases: scan ? releaseNode : releaseNode.optional() });
  return augment(
    gql,
    repos,
    (count) => query(count, "Details", detailsFragment(scan), true),
    (repo, raw) => {
      const node = schema.parse(raw);
      return details(repo, node, node.releases);
    },
    { rules: 50 },
  );
}
async function observe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
export async function gatherRepoRestSignals(
  rest: GitHubClient,
  repo: DiscoveredRepo,
): Promise<RepoRestSignals> {
  const slash = repo.nameWithOwner.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid repository path: ${repo.nameWithOwner}`);
  const params = {
    owner: repo.nameWithOwner.slice(0, slash),
    repo: repo.nameWithOwner.slice(slash + 1),
  };
  const [webhooksCount, hasCodeScanningAlerts, collaboratorsCount, tagProtectionCount] =
    await Promise.all([
      observe(() => countByPagination(rest, "GET /repos/{owner}/{repo}/hooks", params)),
      observe(async () => {
        const data = (
          await rest.request("GET /repos/{owner}/{repo}/code-scanning/alerts", {
            ...params,
            per_page: 1,
          })
        ).data;
        return Array.isArray(data) ? data.length > 0 : null;
      }),
      observe(() =>
        countByPagination(rest, "GET /repos/{owner}/{repo}/collaborators", {
          ...params,
          affiliation: "direct",
        }),
      ),
      observe(async () => {
        const data = (await rest.request("GET /repos/{owner}/{repo}/tags/protection", params)).data;
        return Array.isArray(data) ? data.length : null;
      }),
    ]);
  return { webhooksCount, hasCodeScanningAlerts, collaboratorsCount, tagProtectionCount };
}
