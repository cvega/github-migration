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
 * from the REST `GET /orgs/{org}/repos` listing (the `minimal-repository`
 * shape) — one cheap, reliable paged call that lists the whole org without ever
 * hitting GraphQL's 10s query timeout. This is the spine each later GraphQL
 * augmentation (the indexed `totalCount`s) hangs off.
 */
export interface DiscoveredRepo {
  /** Repo name (without owner). */
  name: string;
  /** `owner/name`. */
  nameWithOwner: string;
  visibility: RepoVisibility;
  isArchived: boolean;
  isFork: boolean;
  /** Proxy for “no commits”: the REST listing reports `size === 0`. */
  isEmpty: boolean;
  /** REST `size` in KiB; null when the listing omits it. */
  diskUsageKb: number | null;
  hasWiki: boolean;
  hasIssues: boolean;
  hasProjects: boolean;
  hasDiscussions: boolean;
  /**
   * Whether GitHub Pages is enabled (`has_pages` from the org listing — free, no
   * per-repo call). Pages settings migrate but typically need reconfiguring.
   */
  hasPages: boolean;
  /** Default branch name, or null for an empty repo with no commits. */
  defaultBranch: string | null;
  /** ISO timestamp of the last push, or null if never pushed. */
  pushedAt: string | null;
  /** ISO timestamp of the last update, or null. */
  updatedAt: string | null;
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
  // ── Per-repo REST signals (gathered in the REST signals pass) ─────────────
  // Cheap single-count / presence checks via REST (the `Link`-header trick or a
  // 200/404 probe). Permission-sensitive endpoints (hooks, code scanning)
  // degrade to 0/false for a read-only token rather than failing the repo.
  /** Webhooks (`GET …/hooks`); migrate but arrive disabled, and their secrets
   *  are not migrated. Needs `admin:repo_hook`/`repo`; 0 when unreadable. */
  webhooksCount: number;
  /** Whether the repo has code-scanning alerts (`GET …/code-scanning/alerts`).
   *  Scanning history is not migrated. False when scanning is off or unreadable. */
  hasCodeScanningAlerts: boolean;
  /** Direct collaborators (`GET …/collaborators?affiliation=direct`); per-repo
   *  user/team access is not migrated and must be re-granted. 0 when unreadable. */
  collaboratorsCount: number;
  /** Tag protection rules (`GET …/tags/protection`); not migrated. 0 when none
   *  or unreadable. GitHub now recommends expressing these as rulesets. */
  tagProtectionCount: number;
  // ── Content-volume counts (migration scale) ──────────────────────────────
  // Indexed GraphQL `totalCount`s gathered in the cheap counts pass (they live
  // here, not on the REST discovery spine, because REST doesn't expose the
  // GraphQL-equivalent counts). Each defaults to 0 until the counts pass fills
  // it; a counts timeout degrades a repo to 0 rather than dropping it.
  /** Issues (`issues.totalCount`, all states; excludes PRs). */
  issuesCount: number;
  /** Pull requests (`pullRequests.totalCount`, all states). */
  pullRequestsCount: number;
  /** Branches (`refs` under `refs/heads/`). */
  branchesCount: number;
  /** Tags (`refs` under `refs/tags/`). */
  tagsCount: number;
  /**
   * Releases (`releases.totalCount`); GHES releases don't migrate at all. Drives
   * the details pass's release-asset-scan partition (repos with 0 skip it).
   */
  releasesCount: number;
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
  /** Org teams (`/orgs/{org}/teams`) — neither teams nor membership migrate. */
  teams: number;
  /** Installed GitHub Apps (`/orgs/{org}/installations`) — not migrated. */
  appInstallations: number;
}

/** All-zero org resources — the default before gathering (and on total failure). */
export const ZERO_ORG_RESOURCES: OrgResources = {
  actionsSecrets: 0,
  actionsVariables: 0,
  dependabotSecrets: 0,
  codespacesSecrets: 0,
  selfHostedRunners: 0,
  customProperties: 0,
  teams: 0,
  appInstallations: 0,
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
  /** Total GitHub API requests the crawl made (REST + GraphQL, incl. retries and
   *  each pagination page). Persisted at completion for cost/rate-limit visibility. */
  apiCalls: number;
  startedAt: string;
  completedAt: string | null;
  failureReason: string | null;
  /** The enterprise run this org belongs to, or null for a standalone org run. */
  enterpriseRunId: string | null;
}

/**
 * An enterprise-scoped profiling run: a parent that fans out to one child
 * {@link ProfileRun} per organization in the enterprise. Its aggregate counters
 * are recomputed from its child runs as they complete, so the enterprise view
 * stays correct even while some orgs are still crawling.
 */
export interface EnterpriseRun {
  id: string;
  /** The enterprise URL slug (not the display name) being profiled. */
  enterpriseSlug: string;
  sourceApiUrl: string;
  state: ProfileRunState;
  /** Organizations discovered in the enterprise, set once enumeration completes. */
  totalOrgs: number;
  /** Child org runs that have reached a terminal state (completed or failed). */
  profiledOrgs: number;
  /** Repositories across all child runs (sum, recomputed as children settle). */
  totalRepos: number;
  /** Repositories profiled across all child runs (sum). */
  profiledRepos: number;
  /** Total applying blocker-severity gaps across all child runs. */
  blockers: number;
  /** Total applying warn-severity gaps across all child runs. */
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
  /** Which crawl phase emitted this nudge (drives the live phase label). */
  phase: ProfilePhase;
}

/**
 * The crawl's coarse phases, in order. Each emits progress nudges so the live
 * UI can show what the run is doing right now:
 *   - `discovering` — listing the org's repositories (REST).
 *   - `organization` — gathering org-level resources (rulesets, secrets, teams…).
 *   - `counting` — the cheap per-repo `totalCount` pass.
 *   - `details` — the expensive per-repo pass (LFS, workflows, release assets).
 *   - `signals` — the per-repo REST pass (commits, webhooks, collaborators…).
 */
export type ProfilePhase = "discovering" | "organization" | "counting" | "details" | "signals";

/**
 * The enterprise crawl's coarse phases:
 *   - `enumerating` — listing the enterprise's organizations (GraphQL).
 *   - `organizations` — profiling each org as a child run.
 */
export type EnterprisePhase = "enumerating" | "organizations";

/** Progress emitted by the enterprise runner as orgs are enumerated and settle. */
export interface EnterpriseProgress {
  enterpriseRunId: string;
  phase: EnterprisePhase;
  /** Organizations discovered (0 until enumeration completes). */
  totalOrgs: number;
  /** Child org runs that have reached a terminal state so far. */
  profiledOrgs: number;
  /** The org just settled (`owner` login), or "" for a phase-only nudge. */
  org: string;
}
