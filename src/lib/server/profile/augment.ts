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

/** GraphQL caps `branchProtectionRules(first:)` at 100; most repos have <10, so
 *  50 covers virtually all of them while halving the worst-case node fan-out. */
const MAX_RULES = 50;

/**
 * Bounded release scan: first N releases, first M assets each (an estimate).
 * Kept deliberately shallow — `releases(first:){releaseAssets(first:)}` is a
 * deeply nested connection, the main driver of the 10s query timeout when many
 * repos are aliased into one request.
 */
const RELEASES_SCANNED = 50;
const ASSETS_SCANNED = 30;

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

/** Cheap per-repo counts: pure `{ totalCount }` / scalar fields, no git reads
 *  and no node materialization — indexed reads that batch safely. */
interface RepoCountsNode {
  discussions: { totalCount: number };
  projectsV2: { totalCount: number };
  environments: { totalCount: number };
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  packages: { totalCount: number };
  /** Repo-level rulesets. The connection is nullable in the schema (no `!`). */
  rulesets: { totalCount: number } | null;
  branchProtectionRules: { totalCount: number };
}

/**
 * Expensive per-repo verification fields: a commit-graph walk
 * (`history.totalCount`), two git-object reads (`.gitattributes`,
 * `.github/workflows`), branch-protection rule detail, and the release-asset
 * scan. Gathered in a second pass so a timeout here can't block the counts.
 */
interface RepoDetailsNode {
  defaultBranchRef: { target: { history: { totalCount: number } } | null } | null;
  /** Root `.gitattributes` on the default branch (`Blob`), or null if absent. */
  gitattributes: { text: string | null } | null;
  /** `.github/workflows` dir on the default branch (`Tree`), or null if absent. */
  workflows: { entries: { name: string }[] } | null;
  /** Present only when the release-asset scan is requested (`scanReleases`). */
  releases?: {
    nodes: { releaseAssets: { nodes: { size: number }[] } }[];
  };
  branchProtectionRules: { nodes: BranchProtectionRuleNode[] };
}

/** The verification fields the details pass produces, merged onto the counts. */
export interface RepoDetails {
  nameWithOwner: string;
  commitsCount: number;
  branchProtectionRulesUsingUnmigratedFeatures: number;
  usesLfs: boolean;
  workflowFileCount: number;
  releaseAssetBytes: number;
}

/**
 * Cheap counts fragment — every field is an indexed `totalCount` or a scalar,
 * so it materializes no nodes and does no git-object reads. This is the first
 * pass: it fills the page's per-repo counts fast and is very unlikely to hit
 * GitHub's 10s timeout even at the batch ceiling.
 */
const COUNTS_FRAGMENT = `fragment Counts on Repository {
  discussions { totalCount }
  projectsV2 { totalCount }
  environments { totalCount }
  stargazerCount
  forkCount
  watchers { totalCount }
  packages { totalCount }
  rulesets(first: 1, includeParents: false) { totalCount }
  branchProtectionRules(first: 1) { totalCount }
}`;

/**
 * Verification fragment — the expensive parts: the commit-graph walk
 * (`history.totalCount`), two git-object reads (`.gitattributes`,
 * `.github/workflows`), branch-protection rule detail, and (when `scanReleases`)
 * the release-asset scan. Run as a second pass so a timeout here degrades a
 * repo's verification rather than blocking its counts.
 */
function detailsFragment(scanReleases: boolean): string {
  const releases = scanReleases
    ? `releases(first: ${RELEASES_SCANNED}) { nodes { releaseAssets(first: ${ASSETS_SCANNED}) { nodes { size } } } }`
    : "";
  return `fragment Details on Repository {
  defaultBranchRef { target { ... on Commit { history(first: 1) { totalCount } } } }
  gitattributes: object(expression: "HEAD:.gitattributes") { ... on Blob { text } }
  workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
  ${releases}
  branchProtectionRules(first: $rules) {
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
}

/**
 * Build an aliased query (`r0: repository(...) {...} …`) over `fragmentName` for
 * a chunk of `n` repos. `$rules` is declared only when the fragment uses it
 * (the details pass), so the counts query carries no unused variable.
 */
function buildAliasedQuery(
  n: number,
  fragmentName: string,
  fragment: string,
  withRules: boolean,
): string {
  const varDefs = withRules ? ["$rules: Int!"] : [];
  const fields: string[] = [];
  for (let i = 0; i < n; i++) {
    varDefs.push(`$o${i}: String!`, `$n${i}: String!`);
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ...${fragmentName} }`);
  }
  const head = varDefs.length > 0 ? `(${varDefs.join(", ")})` : "";
  return `query batch${head} {\n${fields.join("\n")}\n}\n${fragment}`;
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

/** Sum the byte size of every scanned release asset in a details node. */
function sumReleaseAssetBytes(releases: RepoDetailsNode["releases"]): number {
  if (!releases) return 0;
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

/**
 * Map a repo + its (possibly null) counts node to `RepoSignals`, with the
 * verification fields at their defaults — the details pass fills those in. A
 * null node (inaccessible repo) keeps the discovery spine with zeroed counts.
 */
function countsToSignals(repo: DiscoveredRepo, node: RepoCountsNode | null): RepoSignals {
  return {
    ...repo,
    // Verification fields — defaults until the details pass merges them in.
    commitsCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    usesLfs: false,
    workflowFileCount: 0,
    releaseAssetBytes: 0,
    // Cheap counts.
    discussionsCount: node?.discussions.totalCount ?? 0,
    projectsV2Count: node?.projectsV2.totalCount ?? 0,
    environmentsCount: node?.environments.totalCount ?? 0,
    stargazerCount: node?.stargazerCount ?? 0,
    watcherCount: node?.watchers.totalCount ?? 0,
    forkCount: node?.forkCount ?? 0,
    packagesCount: node?.packages.totalCount ?? 0,
    rulesetCount: node?.rulesets?.totalCount ?? 0,
    branchProtectionRuleCount: node?.branchProtectionRules.totalCount ?? 0,
  };
}

/** Map a repo + its (possibly null) details node to the verification fields. */
function toDetails(repo: DiscoveredRepo, node: RepoDetailsNode | null): RepoDetails {
  return {
    nameWithOwner: repo.nameWithOwner,
    commitsCount: node?.defaultBranchRef?.target?.history.totalCount ?? 0,
    branchProtectionRulesUsingUnmigratedFeatures: node
      ? node.branchProtectionRules.nodes.filter(usesUnmigratedFeature).length
      : 0,
    usesLfs: usesLfsAttributes(node?.gitattributes ?? null),
    workflowFileCount: countWorkflowFiles(node?.workflows ?? null),
    releaseAssetBytes: sumReleaseAssetBytes(node?.releases),
  };
}

/** Recover partial `data` from a GraphQL error that carries it, else null. */
function partialDataFromError(err: unknown): Record<string, unknown> | null {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") return data as Record<string, unknown>;
  }
  return null;
}

/**
 * Whether an error is a GitHub processing timeout. The GraphQL API terminates
 * any request that takes longer than ~10s and responds with a 502 or 504 (or a
 * "Something went wrong while executing your query" message). These carry no
 * usable partial data — the remedy is to make the query cheaper, i.e. split it.
 */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; message?: string };
  if (e.status === 502 || e.status === 504) return true;
  return (
    typeof e.message === "string" &&
    /timeout|timed out|executing your query|respond to your request in time/i.test(e.message)
  );
}

/** Options controlling how wide/deep a single augment request reaches. */
export interface AugmentOptions {
  /**
   * Whether to include the heavy release-asset scan. Pass `false` for repos
   * discovery already knows have zero releases, so they can be batched far wider.
   * Defaults to `true` (scan), the safe behavior for an unpartitioned call.
   */
  scanReleases?: boolean;
}

/**
 * Shared batched-augment control flow: one aliased request over a chunk of
 * repos, with three layers of resilience —
 *   - a GitHub processing timeout (502/504) splits the chunk and recurses on the
 *     halves until each query is cheap enough to evaluate in the 10s window;
 *   - a single repo that still times out degrades via `toOut(repo, null)`
 *     (keeping its discovery spine) so one pathological repo can't fail the run;
 *   - a partial-data error (one inaccessible repo in the chunk) is recovered so
 *     the accessible repos still map.
 *
 * `buildQuery` and `toOut` specialize it for the counts vs. details passes.
 */
async function batchedAugment<TNode, TOut>(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
  buildQuery: (n: number) => string,
  toOut: (repo: DiscoveredRepo, node: TNode | null) => TOut,
  extraVars: Record<string, number> = {},
): Promise<TOut[]> {
  if (repos.length === 0) return [];

  const variables: Record<string, string | number> = { ...extraVars };
  repos.forEach((repo, i) => {
    variables[`o${i}`] = ownerOf(repo.nameWithOwner);
    variables[`n${i}`] = repo.name;
  });

  let data: Record<string, TNode | null>;
  try {
    data = await gql<Record<string, TNode | null>>(buildQuery(repos.length), variables);
  } catch (err) {
    if (isTimeoutError(err)) {
      if (repos.length === 1) {
        const only = repos[0];
        console.warn(
          `[profile] augment timed out for a single repo${only ? ` (${only.nameWithOwner})` : ""}; recording it with zeroed signals`,
        );
        return only ? [toOut(only, null)] : [];
      }
      const mid = Math.ceil(repos.length / 2);
      console.warn(
        `[profile] augment timed out for ${repos.length} repos; splitting ${mid} + ${repos.length - mid} and retrying`,
      );
      const left = await batchedAugment(gql, repos.slice(0, mid), buildQuery, toOut, extraVars);
      const right = await batchedAugment(gql, repos.slice(mid), buildQuery, toOut, extraVars);
      return [...left, ...right];
    }
    const partial = partialDataFromError(err);
    if (!partial) throw err;
    data = partial as Record<string, TNode | null>;
  }

  return repos.map((repo, i) => toOut(repo, data[`r${i}`] ?? null));
}

/**
 * Pass 1 — gather each repo's cheap counts in one aliased request per chunk.
 * The returned `RepoSignals` have their verification fields at defaults; the
 * details pass fills those in.
 *
 * @param gql   Injected GraphQL client (`createSingleClient(...).graphql`).
 * @param repos The chunk of repositories (from discovery) to count.
 * @returns     One `RepoSignals` per input repo, in input order.
 */
export function augmentRepoCounts(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
): Promise<RepoSignals[]> {
  return batchedAugment<RepoCountsNode, RepoSignals>(
    gql,
    repos,
    (n) => buildAliasedQuery(n, "Counts", COUNTS_FRAGMENT, false),
    countsToSignals,
  );
}

/**
 * Pass 2 — gather each repo's expensive verification details (commit count, LFS
 * usage, workflow presence, release-asset bytes, branch-protection detail) in
 * one aliased request per chunk.
 *
 * @param gql   Injected GraphQL client.
 * @param repos The chunk of repositories to verify.
 * @param opts  Per-request options (e.g. whether to scan release assets).
 * @returns     One `RepoDetails` per input repo, in input order.
 */
export function augmentRepoDetails(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
  opts: AugmentOptions = {},
): Promise<RepoDetails[]> {
  const scanReleases = opts.scanReleases ?? true;
  return batchedAugment<RepoDetailsNode, RepoDetails>(
    gql,
    repos,
    (n) => buildAliasedQuery(n, "Details", detailsFragment(scanReleases), true),
    toDetails,
    { rules: MAX_RULES },
  );
}
