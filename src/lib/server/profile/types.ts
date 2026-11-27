/** Server-only profile execution and persistence types. */
import type { DiscoveredRepo, OrgResources, RepoSignals } from "$lib/profile/types";

export type {
  DiscoveredRepo,
  OrgResources,
  ProfileRun,
  ProfileRunState,
  RepoSignals,
  RepoVisibility,
} from "$lib/profile/types";

/** Progress emitted after each discovery page (drives SSE and logging). */
export interface DiscoveryProgress {
  org: string;
  /** Repositories collected so far. */
  discovered: number;
  /** Organization repository total, known from the first page onward. */
  total: number;
  /** One-based page number just processed. */
  page: number;
}

/** Result of a completed organization discovery crawl. */
export interface OrgDiscovery {
  org: string;
  /** The organization's reported repository total. */
  total: number;
  repos: DiscoveredRepo[];
}

/** Organization resource counts before observation. */
export const UNKNOWN_ORG_RESOURCES: OrgResources = {
  actionsSecrets: null,
  actionsVariables: null,
  dependabotSecrets: null,
  codespacesSecrets: null,
  selfHostedRunners: null,
  customProperties: null,
  teams: null,
  appInstallations: null,
};

/** A persisted match keyed by migration catalog entry ID. */
export interface StoredCatalogMatch {
  catalogEntryId: string;
  evidence: string;
}

/** One repository's persisted profile within a run. */
export interface StoredRepoProfile {
  nameWithOwner: string;
  signals: RepoSignals;
  blockers: number;
  warnings: number;
  infos: number;
  catalogMatches: StoredCatalogMatch[];
}

/** Progress emitted by the runner after each repository is profiled. */
export interface ProfileProgress {
  runId: string;
  profiled: number;
  total: number;
  repo: string;
  phase: ProfilePhase;
}

/** Ordered phases emitted by a GitHub readiness assessment. */
export type ProfilePhase = "discovering" | "organization" | "counting" | "details" | "signals";
