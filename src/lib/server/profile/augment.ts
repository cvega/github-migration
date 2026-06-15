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

/** Raw shape of one repository alias in the batched signals query. */
interface RepoSignalsNode {
  discussions: { totalCount: number };
  projectsV2: { totalCount: number };
  environments: { totalCount: number };
  /** Present only when the release-asset scan is requested (`scanReleases`). */
  releases?: {
    nodes: { releaseAssets: { nodes: { size: number }[] } }[];
  };
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  packages: { totalCount: number };
  /** Repo-level rulesets. The connection is nullable in the schema (no `!`). */
  rulesets: { totalCount: number } | null;
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
 * The per-repo selection. Almost everything here is a scalar or a
 * `{ totalCount }`-only connection: per GitHub's node-limit rules those don't
 * materialize `nodes`/`edges`, so they're indexed reads that stay cheap even
 * when many repos are aliased into one request. The one exception is the
 * release-asset scan (`releases{...releaseAssets}`), a deeply-nested walk that
 * materializes nodes — included only when `scanReleases` is set so repos
 * discovery already knows have zero releases can be batched far wider.
 *
 * Deliberately omits commit count (`history.totalCount`): unlike the other
 * counts it is NOT indexed — it walks the whole commit graph — making it the
 * single most expensive resolver and the main cause of the 10s query timeout
 * when repos are aliased, while being pure scale decoration (history migrates
 * wholesale).
 */
function signalsFragment(scanReleases: boolean): string {
  const releases = scanReleases
    ? `releases(first: ${RELEASES_SCANNED}) { nodes { releaseAssets(first: ${ASSETS_SCANNED}) { nodes { size } } } }`
    : "";
  return `fragment Sig on Repository {
  discussions { totalCount }
  projectsV2 { totalCount }
  environments { totalCount }
  ${releases}
  stargazerCount
  forkCount
  watchers { totalCount }
  packages { totalCount }
  rulesets(first: 1, includeParents: false) { totalCount }
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
}

/** Build the aliased query for a chunk of `n` repos (aliases `r0…r{n-1}`). */
function buildBatchQuery(n: number, scanReleases: boolean): string {
  const varDefs = ["$rules: Int!"];
  const fields: string[] = [];
  for (let i = 0; i < n; i++) {
    varDefs.push(`$o${i}: String!`, `$n${i}: String!`);
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ...Sig }`);
  }
  return `query batchSignals(${varDefs.join(", ")}) {\n${fields.join("\n")}\n}\n${signalsFragment(scanReleases)}`;
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

/** Map a repo + its (possibly null) augment node to full `RepoSignals`. */
function toSignals(repo: DiscoveredRepo, node: RepoSignalsNode | null): RepoSignals {
  // A null node means the repo was inaccessible on this pass (permissions edge,
  // or deleted between passes). It was discoverable, so keep the discovery spine
  // and degrade the augment counts to zero rather than failing the run.
  if (!node) {
    return {
      ...repo,
      discussionsCount: 0,
      projectsV2Count: 0,
      environmentsCount: 0,
      stargazerCount: 0,
      watcherCount: 0,
      forkCount: 0,
      rulesetCount: 0,
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
    discussionsCount: node.discussions.totalCount,
    projectsV2Count: node.projectsV2.totalCount,
    environmentsCount: node.environments.totalCount,
    stargazerCount: node.stargazerCount,
    watcherCount: node.watchers.totalCount,
    forkCount: node.forkCount,
    rulesetCount: node.rulesets?.totalCount ?? 0,
    branchProtectionRuleCount: node.branchProtectionRules.totalCount,
    branchProtectionRulesUsingUnmigratedFeatures:
      node.branchProtectionRules.nodes.filter(usesUnmigratedFeature).length,
    packagesCount: node.packages.totalCount,
    usesLfs: usesLfsAttributes(node.gitattributes),
    releaseAssetBytes: sumReleaseAssetBytes(node.releases),
    workflowFileCount: countWorkflowFiles(node.workflows),
  };
}

/** Recover partial `data` from a GraphQL error that carries it, else null. */
function partialDataFromError(err: unknown): BatchSignalsResult | null {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") return data as BatchSignalsResult;
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
 * Enrich a chunk of discovered repositories with their per-repo signals in a
 * single aliased GraphQL request.
 *
 * @param gql   Injected GraphQL client (`createSingleClient(...).graphql`).
 * @param repos The chunk of repositories (from discovery) to augment.
 * @param opts  Per-request options (e.g. whether to scan release assets).
 * @returns     One `RepoSignals` per input repo, in input order.
 */
export async function augmentRepoSignals(
  gql: typeof graphql,
  repos: DiscoveredRepo[],
  opts: AugmentOptions = {},
): Promise<RepoSignals[]> {
  if (repos.length === 0) return [];

  const variables: Record<string, string | number> = { rules: MAX_RULES };
  repos.forEach((repo, i) => {
    variables[`o${i}`] = ownerOf(repo.nameWithOwner);
    variables[`n${i}`] = repo.name;
  });

  let data: BatchSignalsResult;
  try {
    data = await gql<BatchSignalsResult>(
      buildBatchQuery(repos.length, opts.scanReleases ?? true),
      variables,
    );
  } catch (err) {
    // A GitHub processing timeout (502/504): the query was too expensive to
    // evaluate in GitHub's 10s window. Splitting the chunk makes each query
    // cheaper; recurse on the halves until it fits. A single repo that still
    // times out degrades to zeroed augment signals (keeping its discovery
    // spine) so one pathological repo can't fail the whole crawl.
    if (isTimeoutError(err)) {
      if (repos.length === 1) {
        const only = repos[0];
        console.warn(
          `[profile] augment timed out for a single repo${only ? ` (${only.nameWithOwner})` : ""}; recording it with zeroed signals`,
        );
        return only ? [toSignals(only, null)] : [];
      }
      const mid = Math.ceil(repos.length / 2);
      console.warn(
        `[profile] augment timed out for ${repos.length} repos; splitting ${mid} + ${repos.length - mid} and retrying`,
      );
      const left = await augmentRepoSignals(gql, repos.slice(0, mid), opts);
      const right = await augmentRepoSignals(gql, repos.slice(mid), opts);
      return [...left, ...right];
    }
    // A chunk with one inaccessible repo errors but still carries partial data;
    // recover it so the accessible repos in the chunk still get profiled.
    const partial = partialDataFromError(err);
    if (!partial) throw err;
    data = partial;
  }

  return repos.map((repo, i) => toSignals(repo, data[`r${i}`] ?? null));
}
