/**
 * Per-repo signal augmentation — the GraphQL passes that enrich the REST spine.
 *
 * Discovery (`discover.ts`) lists the org via REST, giving the cheap spine
 * (names, visibility, sizes, feature toggles). These passes add the indexed
 * GraphQL signals on top, batched:
 *   - the COUNTS pass: pure `{ totalCount }`/scalar fields (issues, PRs,
 *     branches, tags, releases, discussions, …) — indexed reads that don't
 *     materialize nodes, so they batch safely;
 *   - the DETAILS pass: the expensive verification (commit-graph walk,
 *     git-object reads, branch-protection rule node detail, release-asset scan).
 *
 * Each pass profiles a CHUNK of repos in one aliased GraphQL request
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
import { isTimeoutError } from "./graphql-errors";
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
  /** Repo-level rulesets. The connection is nullable in the schema (no `!`). */
  rulesets: { totalCount: number } | null;
  branchProtectionRules: { totalCount: number };
}

/**
 * Expensive per-repo verification fields: two git-object reads
 * (`.gitattributes`, `.github/workflows`), branch-protection rule detail, and
 * the release-asset scan. Gathered in a second pass so a timeout here can't
 * block the counts. (Commit count is gathered separately via REST — see
 * `commits.ts` — because GraphQL's `history.totalCount` walks the whole commit
 * graph and times out at scale.)
 */
interface RepoDetailsNode {
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
  issues { totalCount }
  pullRequests { totalCount }
  branches: refs(refPrefix: "refs/heads/", first: 1) { totalCount }
  tags: refs(refPrefix: "refs/tags/", first: 1) { totalCount }
  releases { totalCount }
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
 * Verification fragment — the expensive parts: two git-object reads
 * (`.gitattributes`, `.github/workflows`), branch-protection rule detail, and
 * (when `scanReleases`) the release-asset scan. Run as a second pass so a
 * timeout here degrades a repo's verification rather than blocking its counts.
 */
function detailsFragment(scanReleases: boolean): string {
  const releases = scanReleases
    ? `releases(first: ${RELEASES_SCANNED}) { nodes { releaseAssets(first: ${ASSETS_SCANNED}) { nodes { size } } } }`
    : "";
  return `fragment Details on Repository {
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
    // Verification fields — defaults until the details / REST passes merge them in.
    commitsCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    usesLfs: false,
    workflowFileCount: 0,
    releaseAssetBytes: 0,
    webhooksCount: 0,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
    // Cheap counts.
    issuesCount: node?.issues.totalCount ?? 0,
    pullRequestsCount: node?.pullRequests.totalCount ?? 0,
    branchesCount: node?.branches.totalCount ?? 0,
    tagsCount: node?.tags.totalCount ?? 0,
    releasesCount: node?.releases.totalCount ?? 0,
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

/**
 * A repo's signals with only the discovery spine — every augmented field at its
 * default. Recorded at discovery time so each repo is listed immediately; the
 * counts and details passes then enrich it in place. This is the single source
 * of truth for the zeroed shape (it's exactly an un-augmented counts node).
 */
export function baseSignals(repo: DiscoveredRepo): RepoSignals {
  return countsToSignals(repo, null);
}

/** Map a repo + its (possibly null) details node to the verification fields. */
function toDetails(repo: DiscoveredRepo, node: RepoDetailsNode | null): RepoDetails {
  return {
    nameWithOwner: repo.nameWithOwner,
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
