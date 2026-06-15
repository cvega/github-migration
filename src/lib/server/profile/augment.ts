/**
 * Per-repo signal augmentation — the second crawl pass.
 *
 * Discovery (`discover.ts`) gives the cheap, breadth-first spine; this pass
 * enriches one repository with the GraphQL count signals the consideration
 * analysis needs (discussions, projects, environments, releases, stars/watchers,
 * branch
 * protection rules). It's a single bounded query per repo — no asset/ref paging
 * — so deeper size scans (release assets, git-sizer, ref-name length) stay in a
 * separate, heavier pass.
 *
 * The `gql` client is injected, so the query shaping, mapping, and the
 * branch-protection derivation are unit-testable without a network.
 */
import type { graphql } from "@octokit/graphql";
import type { DiscoveredRepo, RepoSignals } from "./types";

/** GraphQL caps `branchProtectionRules(first:)` at 100 — plenty per repo. */
const MAX_RULES = 100;

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

/** Raw shape of the per-repo signals query response. */
interface RepoSignalsResult {
  repository: {
    discussions: { totalCount: number };
    projectsV2: { totalCount: number };
    environments: { totalCount: number };
    releases: { totalCount: number };
    stargazerCount: number;
    watchers: { totalCount: number };
    branchProtectionRules: {
      totalCount: number;
      nodes: BranchProtectionRuleNode[];
    };
  } | null;
}

const REPO_SIGNALS_QUERY = `query repoSignals($owner: String!, $name: String!, $rules: Int!) {
  repository(owner: $owner, name: $name) {
    discussions { totalCount }
    projectsV2 { totalCount }
    environments { totalCount }
    releases { totalCount }
    stargazerCount
    watchers { totalCount }
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
  }
}`;

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

/** Split `owner/name` into its owner; falls back to the whole string. */
function ownerOf(nameWithOwner: string): string {
  const slash = nameWithOwner.indexOf("/");
  return slash > 0 ? nameWithOwner.slice(0, slash) : nameWithOwner;
}

/**
 * Enrich a discovered repository with its per-repo GraphQL signals.
 *
 * @param gql   Injected GraphQL client (`createSingleClient(...).graphql`).
 * @param repo  The repository from the discovery pass to augment.
 * @returns     `repo` plus the gathered count signals (`RepoSignals`).
 * @throws      If the repository is missing or not accessible.
 */
export async function augmentRepoSignals(
  gql: typeof graphql,
  repo: DiscoveredRepo,
): Promise<RepoSignals> {
  const result: RepoSignalsResult = await gql<RepoSignalsResult>(REPO_SIGNALS_QUERY, {
    owner: ownerOf(repo.nameWithOwner),
    name: repo.name,
    rules: MAX_RULES,
  });

  const r = result.repository;
  if (!r) {
    throw new Error(`Repository '${repo.nameWithOwner}' not found or not accessible`);
  }

  const rulesUsingUnmigrated = r.branchProtectionRules.nodes.filter(usesUnmigratedFeature).length;

  return {
    ...repo,
    discussionsCount: r.discussions.totalCount,
    projectsV2Count: r.projectsV2.totalCount,
    environmentsCount: r.environments.totalCount,
    releasesCount: r.releases.totalCount,
    stargazerCount: r.stargazerCount,
    watcherCount: r.watchers.totalCount,
    branchProtectionRuleCount: r.branchProtectionRules.totalCount,
    branchProtectionRulesUsingUnmigratedFeatures: rulesUsingUnmigrated,
  };
}
