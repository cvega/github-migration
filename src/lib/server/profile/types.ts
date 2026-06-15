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
  /**
   * Releases (`releases.totalCount`); GHES releases don't migrate at all.
   * Gathered in discovery (free on the 100-wide page) so the augment pass can
   * skip the heavy release-asset scan for repos that have none.
   */
  releasesCount: number;
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
  /**
   * Commits on the default branch (`history.totalCount`). Gathered in the
   * verification pass, not the cheap counts pass: unlike the indexed
   * `totalCount`s it walks the commit graph, so a timeout degrades it to 0 for
   * that one repo rather than blocking the cheap counts.
   */
  commitsCount: number;
  /** Repository-level Discussions (`discussions.totalCount`); not migrated. */
  discussionsCount: number;
  /** Projects (new experience) (`projectsV2.totalCount`); not migrated. */
  projectsV2Count: number;
  /** Actions environments (`environments.totalCount`); not migrated. */
  environmentsCount: number;
  /**
   * Summed byte size of release assets across the repo's releases (bounded scan:
   * the first 100 releases × first 50 assets each). An estimate — the usual
   * driver of the per-repo release (10 GiB) and metadata-archive (40 GiB) limits.
   */
  releaseAssetBytes: number;
  /** Stars (`stargazerCount`); not migrated. */
  stargazerCount: number;
  /** Watchers (`watchers.totalCount`); not migrated. */
  watcherCount: number;
  /** Forks (`forkCount`); fork relationships are not migrated. */
  forkCount: number;
  /** Repository-level rulesets (`rulesets.totalCount`); not migrated. */
  rulesetCount: number;
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
  /**
   * Workflow files under `.github/workflows` on the default branch. Workflows
   * themselves migrate, but their run history and artifacts do not — so `> 0`
   * means there's run history that will be lost.
   */
  workflowFileCount: number;
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Lifecycle state of a profiling run. */
export type ProfileRunState = "running" | "completed" | "failed";

/**
 * Organization-level resources gathered once per run (REST). These are scoped
 * to the org (not per-repo), are not migrated, and must be recreated on the
 * target. Each degrades to 0 when its endpoint is unavailable or unauthorized.
 */
export interface OrgResources {
  /** Org Actions secrets (`/orgs/{org}/actions/secrets`). */
  actionsSecrets: number;
  /** Org Actions variables (`/orgs/{org}/actions/variables`). */
  actionsVariables: number;
  /** Org Dependabot secrets (`/orgs/{org}/dependabot/secrets`). */
  dependabotSecrets: number;
  /** Org Codespaces secrets (`/orgs/{org}/codespaces/secrets`). */
  codespacesSecrets: number;
  /** Org self-hosted runners (`/orgs/{org}/actions/runners`). */
  selfHostedRunners: number;
  /** Org custom-property definitions (`/orgs/{org}/properties/schema`). */
  customProperties: number;
}

/** All-zero org resources — the default before gathering (and on total failure). */
export const ZERO_ORG_RESOURCES: OrgResources = {
  actionsSecrets: 0,
  actionsVariables: 0,
  dependabotSecrets: 0,
  codespacesSecrets: 0,
  selfHostedRunners: 0,
  customProperties: 0,
};

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
  /** Organization rulesets (REST); not migrated, and can fail the migration. */
  orgRulesetCount: number;
  /** Organization-level resources (secrets, runners, …) gathered once per run. */
  orgResources: OrgResources;
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
