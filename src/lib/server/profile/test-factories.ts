/**
 * Shared test factories for the profile domain. The per-repo `DiscoveredRepo`
 * and `RepoSignals` builders were duplicated across nearly every profile test;
 * these are the single source of truth. Each builder fills sensible defaults and
 * takes an `over` patch, so a test states only the fields it cares about.
 *
 * Not a `.test.ts` file — it defines no tests, it's imported by them.
 */
import type { RepoDetails } from "./augment";
import type { DiscoveredRepo, RepoSignals } from "./types";

/** A discovered repo with sensible defaults; `over` patches any field. */
export function makeDiscoveredRepo(
  name: string,
  over: Partial<DiscoveredRepo> = {},
): DiscoveredRepo {
  return {
    name,
    nameWithOwner: `acme/${name}`,
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb: 100,
    hasWiki: false,
    hasIssues: true,
    hasProjects: false,
    hasDiscussions: false,
    hasPages: false,
    defaultBranch: "main",
    pushedAt: null,
    updatedAt: null,
    ...over,
  };
}

/** A fully-enriched `RepoSignals` (all counts zero) over a discovered repo. */
export function makeRepoSignals(
  repo: DiscoveredRepo,
  over: Partial<RepoSignals> = {},
): RepoSignals {
  return {
    ...repo,
    commitsCount: 0,
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
    webhooksCount: 0,
    hasPages: false,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 0,
    tagsCount: 0,
    releasesCount: 0,
    ...over,
  };
}

/**
 * Counts-pass signals: like {@link makeRepoSignals} but with the verification
 * fields (commits, branch-protection detail, LFS, workflows, release bytes)
 * forced to their pass-1 defaults, as the cheap counts pass produces.
 */
export function makeCountsSignals(
  repo: DiscoveredRepo,
  over: Partial<RepoSignals> = {},
): RepoSignals {
  return {
    ...makeRepoSignals(repo, over),
    commitsCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    usesLfs: false,
    workflowFileCount: 0,
    releaseAssetBytes: 0,
  };
}

/** Pass-2 verification details for a repo, derived from {@link makeRepoSignals}. */
export function makeRepoDetails(
  repo: DiscoveredRepo,
  over: Partial<RepoSignals> = {},
): RepoDetails {
  const s = makeRepoSignals(repo, over);
  return {
    nameWithOwner: repo.nameWithOwner,
    branchProtectionRulesUsingUnmigratedFeatures: s.branchProtectionRulesUsingUnmigratedFeatures,
    usesLfs: s.usesLfs,
    workflowFileCount: s.workflowFileCount,
    releaseAssetBytes: s.releaseAssetBytes,
  };
}
