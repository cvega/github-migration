/**
 * Types for the Profiler's source-discovery crawl.
 *
 * Discovery is the bulk, breadth-first pass: a single GraphQL query paged over
 * an organization's repositories yields cheap, high-signal metadata for every
 * repo (size, visibility, archived/fork/empty flags, feature toggles, activity
 * timestamps). Later passes augment each repo with the per-feature signals the
 * gap analysis needs (packages, secrets, webhooks, rulesets, release sizes…).
 *
 * Names here are deliberately distinct from `github.ts`'s `RepoFacts` (the
 * cleanup-time identity record) — this is profile data, a different concern.
 */

/** A repository's GraphQL `visibility` (GitHub's `RepositoryVisibility` enum). */
export type RepoVisibility = "PUBLIC" | "PRIVATE" | "INTERNAL";

/**
 * One repository as surfaced by the bulk discovery crawl. Every field comes
 * from a single GraphQL page — no per-repo REST calls — so this is cheap to
 * gather at org scale and forms the spine each later augmentation hangs off.
 */
export interface DiscoveredRepo {
  /** Repo name (without owner). */
  name: string;
  /** `owner/name`. */
  nameWithOwner: string;
  visibility: RepoVisibility;
  isArchived: boolean;
  isFork: boolean;
  isEmpty: boolean;
  /** GraphQL `diskUsage` in KiB; null when the viewer can't see it. */
  diskUsageKb: number | null;
  hasWiki: boolean;
  hasIssues: boolean;
  hasProjects: boolean;
  hasDiscussions: boolean;
  /** Default branch name, or null for an empty repo with no commits. */
  defaultBranch: string | null;
  /** ISO timestamp of the last push, or null if never pushed. */
  pushedAt: string | null;
  /** ISO timestamp of the last update, or null. */
  updatedAt: string | null;
  /** Issues (`issues.totalCount`, all states; excludes PRs) — migration scale. */
  issuesCount: number;
  /** Pull requests (`pullRequests.totalCount`, all states) — migration scale. */
  pullRequestsCount: number;
  /** Branches (`refs` under `refs/heads/`) — migration scale. */
  branchesCount: number;
  /** Tags (`refs` under `refs/tags/`) — migration scale. */
  tagsCount: number;
}

/** Progress emitted after each discovery page (drives SSE / logging later). */
export interface DiscoveryProgress {
  org: string;
  /** Repos collected so far. */
  discovered: number;
  /** Org repository total (`totalCount`), known from the first page on. */
  total: number;
  /** 1-based page number just processed. */
  page: number;
}

/** Result of a completed organization discovery crawl. */
export interface OrgDiscovery {
  org: string;
  /** The org's reported repository `totalCount`. */
  total: number;
  repos: DiscoveredRepo[];
}

/**
 * A repository enriched with the per-repo signals the gap analysis needs,
 * beyond the bulk discovery spine. These are the cheap GraphQL count signals
 * gathered in a single query per repo; deeper, paging-heavy signals (release
 * asset sizes, git-sizer, ref-name scans) are augmented separately.
 *
 * Derived signals (e.g. `branchProtectionRulesUsingUnmigratedFeatures`) are
 * computed in the augmentation layer so the gap detectors stay simple — they
 * read a number and compare, rather than re-deriving GraphQL schema details.
 */
export interface RepoSignals extends DiscoveredRepo {
  /** Commits on the default branch (`history.totalCount`) — migration scale. */
  commitsCount: number;
  /** Repository-level Discussions (`discussions.totalCount`); not migrated. */
  discussionsCount: number;
  /** Projects (new experience) (`projectsV2.totalCount`); not migrated. */
  projectsV2Count: number;
  /** Actions environments (`environments.totalCount`); not migrated. */
  environmentsCount: number;
  /** Releases (`releases.totalCount`); GHES releases don't migrate at all. */
  releasesCount: number;
  /** Stars (`stargazerCount`); not migrated. */
  stargazerCount: number;
  /** Watchers (`watchers.totalCount`); not migrated. */
  watcherCount: number;
  /** Branch protection rules (`branchProtectionRules.totalCount`). */
  branchProtectionRuleCount: number;
  /**
   * How many branch protection rules use at least one feature the GitHub export
   * does not carry (force-push allowance, required deployments, lock branch, block
   * creations, require last-push approval, or bypass actors). `> 0` means the
   * branch-protection-partial gap applies.
   */
  branchProtectionRulesUsingUnmigratedFeatures: number;
  /** Packages in GitHub Packages (`packages.totalCount`); not migrated. */
  packagesCount: number;
  /**
   * Whether the default branch's root `.gitattributes` configures Git LFS
   * (`filter=lfs`). LFS objects are not carried by the export and must be pushed
   * post-migration. A proxy: only the root file on the default branch is checked.
   */
  usesLfs: boolean;
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Lifecycle state of a profiling run. */
export type ProfileRunState = "running" | "completed" | "failed";

/**
 * An organization-scoped profiling run. Aggregate counters (`profiledRepos`,
 * `blockers`, `warnings`) are recomputed from the run's repos at completion.
 */
export interface ProfileRun {
  id: string;
  sourceApiUrl: string;
  org: string;
  state: ProfileRunState;
  /** Org repository total, set once discovery reports it. */
  totalRepos: number;
  /** Repos profiled so far (authoritative after completion). */
  profiledRepos: number;
  /** Total applying blocker-severity gaps across the run's repos. */
  blockers: number;
  /** Total applying warn-severity gaps across the run's repos. */
  warnings: number;
  startedAt: string;
  completedAt: string | null;
  failureReason: string | null;
}

/** A persisted finding — applying considerations only, keyed by registry id. */
export interface StoredFinding {
  considerationId: string;
  evidence: string;
}

/** One repository's persisted profile within a run. */
export interface StoredRepoProfile {
  nameWithOwner: string;
  signals: RepoSignals;
  blockers: number;
  warnings: number;
  infos: number;
  /** The considerations that apply to this repo, with their evidence. */
  applyingConsiderations: StoredFinding[];
}

/** Progress emitted by the runner after each repository is profiled. */
export interface ProfileProgress {
  runId: string;
  /** Repos profiled so far. */
  profiled: number;
  /** Org repository total (known once discovery completes). */
  total: number;
  /** The repository just profiled (`owner/name`). */
  repo: string;
}
