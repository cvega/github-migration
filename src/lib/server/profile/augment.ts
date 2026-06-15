/**
 * Per-repo signal augmentation — the second crawl pass, batched.
 *
 * Discovery (`discover.ts`) gives the cheap, breadth-first spine and the
 * content-volume counts that ride along free in each 100-repo page. This pass
 * gathers the signals that can't fold into a discovery node: the
 * branch-protection rule *details* (node-level flags, not just a count) and the
 * default-branch commit count (`history.totalCount`, the one count with timeout
 * risk at 100-wide, so kept to a smaller fan-out here).
 *
 * It profiles a CHUNK of repos in one aliased GraphQL request
 * (`r0: repository(...) {…} r1: repository(...) {…} …`), so an org of N repos
 * costs ~N/chunk requests instead of one per repo. The request is
 * partial-failure aware: if a repo in the chunk is inaccessible, GraphQL
 * returns a null alias plus an `errors` entry (surfaced by the client as an
 * error carrying partial `data`) — that repo degrades to zeroed signals rather
 * than failing the whole chunk.
 *
 * The `gql` client is injected, so the query shaping, mapping, and the
 * branch-protection derivation are unit-testable without a network.
 */
import type { graphql } from "@octokit/graphql";
import type { DiscoveredRepo, RepoSignals } from "./types";

/** GraphQL caps `branchProtectionRules(first:)` at 100 — plenty per repo. */
const MAX_RULES = 100;

/** Bounded release scan: first N releases, first M assets each (an estimate). */
const RELEASES_SCANNED = 100;
const ASSETS_SCANNED = 50;

/** One branch protection rule's migration-relevant flags. */
interface BranchProtectionRuleNode {
  allowsForcePushes: boolean;
  requiresDeployments: boolean;
  lockBranch: boolean;
  blocksCreations: boolean;
  requireLastPushApproval: boolean;
  bypassForcePushAllowances: { totalCount: number };
  bypassPullRequestAllowances: { totalCount: number };
}

/** Raw shape of one repository alias in the batched signals query. */
interface RepoSignalsNode {
  defaultBranchRef: { target: { history: { totalCount: number } } | null } | null;
  discussions: { totalCount: number };
  projectsV2: { totalCount: number };
  environments: { totalCount: number };
  releases: {
    totalCount: number;
    nodes: { releaseAssets: { nodes: { size: number }[] } }[];
  };
  stargazerCount: number;
  watchers: { totalCount: number };
  packages: { totalCount: number };
  /** Root `.gitattributes` on the default branch (`Blob`), or null if absent. */
  gitattributes: { text: string | null } | null;
  /** `.github/workflows` dir on the default branch (`Tree`), or null if absent. */
  workflows: { entries: { name: string }[] } | null;
  branchProtectionRules: {
    totalCount: number;
    nodes: BranchProtectionRuleNode[];
  };
}

/** The aliased query response: one (possibly null) node per requested repo. */
type BatchSignalsResult = Record<string, RepoSignalsNode | null>;

/**
 * The per-repo selection. `history` sits behind a `... on Commit` inline
 * fragment because `defaultBranchRef.target` is a `GitObject` (Commit | Tree |
 * Blob | Tag); only a Commit has `history`.
 */
const SIGNALS_FRAGMENT = `fragment Sig on Repository {
  defaultBranchRef { target { ... on Commit { history(first: 1) { totalCount } } } }
  discussions { totalCount }
  projectsV2 { totalCount }
  environments { totalCount }
  releases(first: ${RELEASES_SCANNED}) {
    totalCount
    nodes { releaseAssets(first: ${ASSETS_SCANNED}) { nodes { size } } }
  }
  stargazerCount
  watchers { totalCount }
  packages { totalCount }
  gitattributes: object(expression: "HEAD:.gitattributes") { ... on Blob { text } }
  workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
  branchProtectionRules(first: $rules) {
    totalCount
    nodes {
      allowsForcePushes
      requiresDeployments
      lockBranch
      blocksCreations
      requireLastPushApproval
      bypassForcePushAllowances { totalCount }
      bypassPullRequestAllowances { totalCount }
    }
  }
}`;

/** Build the aliased query for a chunk of `n` repos (aliases `r0…r{n-1}`). */
function buildBatchQuery(n: number): string {
  const varDefs = ["$rules: Int!"];
  const fields: string[] = [];
  for (let i = 0; i < n; i++) {
    varDefs.push(`$o${i}: String!`, `$n${i}: String!`);
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ...Sig }`);
  }
  return `query batchSignals(${varDefs.join(", ")}) {\n${fields.join("\n")}\n}\n${SIGNALS_FRAGMENT}`;
}

/** Split `owner/name` into its owner; falls back to the whole string. */
function ownerOf(nameWithOwner: string): string {
  const slash = nameWithOwner.indexOf("/");
  return slash > 0 ? nameWithOwner.slice(0, slash) : nameWithOwner;
}

/**
 * Whether a branch protection rule uses any feature the GitHub export does not carry.
 * (Plain required-reviews/status-checks DO migrate, so a rule using only those
 * counts as zero here.)
 */
function usesUnmigratedFeature(rule: BranchProtectionRuleNode): boolean {
  return (
    rule.allowsForcePushes ||
    rule.requiresDeployments ||
    rule.lockBranch ||
    rule.blocksCreations ||
    rule.requireLastPushApproval ||
    rule.bypassForcePushAllowances.totalCount > 0 ||
    rule.bypassPullRequestAllowances.totalCount > 0
  );
}

/**
 * Whether a repo's root `.gitattributes` configures Git LFS. Matches a
 * `filter=lfs` attribute (the marker `git lfs track` writes). Only the default
 * branch's root file is inspected, so LFS configured solely in a subdirectory or
 * a non-default branch is not detected — a deliberate proxy for a cheap signal.
 */
function usesLfsAttributes(gitattributes: { text: string | null } | null): boolean {
  const text = gitattributes?.text;
  return text != null && /filter=lfs/.test(text);
}

/** Sum the byte size of every scanned release asset in a repo node. */
function sumReleaseAssetBytes(releases: RepoSignalsNode["releases"]): number {
  let bytes = 0;
  for (const release of releases.nodes) {
    for (const asset of release.releaseAssets.nodes) bytes += asset.size;
  }
  return bytes;
}

/** Count workflow definition files (`.yml`/`.yaml`) in a `.github/workflows` tree. */
function countWorkflowFiles(workflows: { entries: { name: string }[] } | null): number {
  if (!workflows) return 0;
  return workflows.entries.filter((e) => /\.ya?ml$/i.test(e.name)).length;
}

/** Map a repo + its (possibly null) augment node to full `RepoSignals`. */
function toSignals(repo: DiscoveredRepo, node: RepoSignalsNode | null): RepoSignals {
  // A null node means the repo was inaccessible on this pass (permissions edge,
  // or deleted between passes). It was discoverable, so keep the discovery spine
  // and degrade the augment counts to zero rather than failing the run.
  if (!node) {
    return {
      ...repo,
      commitsCount: 0,
      discussionsCount: 0,
      projectsV2Count: 0,
      environmentsCount: 0,
      releasesCount: 0,
      stargazerCount: 0,
      watcherCount: 0,
      branchProtectionRuleCount: 0,
      branchProtectionRulesUsingUnmigratedFeatures: 0,
      packagesCount: 0,
      usesLfs: false,
      releaseAssetBytes: 0,
      workflowFileCount: 0,
    };
  }
  return {
    ...repo,
    commitsCount: node.defaultBranchRef?.target?.history.totalCount ?? 0,
    discussionsCount: node.discussions.totalCount,
    projectsV2Count: node.projectsV2.totalCount,
    environmentsCount: node.environments.totalCount,
    releasesCount: node.releases.totalCount,
    stargazerCount: node.stargazerCount,
    watcherCount: node.watchers.totalCount,
    branchProtectionRuleCount: node.branchProtectionRules.totalCount,
    branchProtectionRulesUsingUnmigratedFeatures:
      node.branchProtectionRules.nodes.filter(usesUnmigratedFeature).length,
    packagesCount: node.packages.totalCount,
    usesLfs: usesLfsAttributes(node.gitattributes),
    releaseAssetBytes: sumReleaseAssetBytes(node.releases),
    workflowFileCount: countWorkflowFiles(node.workflows),
  };
}

/** Recover partial `data` from a GraphQL error that carries it, else rethrow. */
function dataFromError(err: unknown): BatchSignalsResult {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") return data as BatchSignalsResult;
  }
  throw err;
}

/**
 * Enrich a chunk of discovered repositories with their per-repo signals in a
 * single aliased GraphQL request.
 *
 * @param gql   Injected GraphQL client (`createSingleClient(...).graphql`).
 * @param repos The chunk of repositories (from discovery) to augment.
 * @returns     One `RepoSignals` per input repo, in input order.
 */
export async function augmentRepoSignals(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
): Promise<RepoSignals[]> {
  if (repos.length === 0) return [];

  const variables: Record<string, string | number> = { rules: MAX_RULES };
  repos.forEach((repo, i) => {
    variables[`o${i}`] = ownerOf(repo.nameWithOwner);
    variables[`n${i}`] = repo.name;
  });

  let data: BatchSignalsResult;
  try {
    data = await gql<BatchSignalsResult>(buildBatchQuery(repos.length), variables);
  } catch (err) {
    // A chunk with one inaccessible repo errors but still carries partial data;
    // recover it so the accessible repos in the chunk still get profiled.
    data = dataFromError(err);
  }

  return repos.map((repo, i) => toSignals(repo, data[`r${i}`] ?? null));
}
