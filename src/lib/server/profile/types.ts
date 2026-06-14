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
