export const SOURCE_PROVIDERS = ["github", "gitlab", "bitbucket-server"] as const;

export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

/** Every reason a collector or profile writer may record for a missing observation. */
export const OBSERVATION_UNAVAILABLE_REASONS = [
  "forbidden",
  "not-found-or-hidden",
  "not-reported",
  "unsupported",
  "malformed",
  "transient-failure",
] as const;

type ObservationUnavailableReason = (typeof OBSERVATION_UNAVAILABLE_REASONS)[number];

export type NumericObservation =
  | { kind: "exact"; value: number }
  | { kind: "at-least"; value: number }
  | { kind: "unavailable"; reason: ObservationUnavailableReason };

interface GitLabProjectDetails {
  provider: "gitlab";
  commitCount?: NumericObservation;
  webUrl?: string;
  description?: string | null;
  topics?: string[];
  emptyRepository?: boolean;
  forkedFromPath?: string;
  features?: {
    issues?: boolean;
    mergeRequests?: boolean;
    wiki?: boolean;
    snippets?: boolean;
    containerRegistry?: boolean;
  };
}

interface BitbucketServerProjectDetails {
  provider: "bitbucket-server";
  webUrl?: string;
  description?: string | null;
  scmId?: string;
  forkable?: boolean;
  rootLfsRules?: "found" | "none" | "unknown";
  forkedFromPath?: string;
  state?: string;
}

export type SourceProjectProviderDetails = GitLabProjectDetails | BitbucketServerProjectDetails;

export interface SourceProjectInventory {
  provider: SourceProvider;
  sourceId: string;
  path: string;
  name: string;
  visibility: "public" | "private" | "internal";
  archived: boolean;
  defaultBranch: string | null;
  lastActivityAt: string | null;
  repositorySizeBytes: NumericObservation;
  storageSizeBytes: NumericObservation;
  lfsObjectsSizeBytes: NumericObservation;
  packagesSizeBytes: NumericObservation;
  wikiSizeBytes: NumericObservation;
  uploadsSizeBytes: NumericObservation;
  jobArtifactsSizeBytes: NumericObservation;
  pipelineArtifactsSizeBytes: NumericObservation;
  snippetsSizeBytes: NumericObservation;
  containerRegistrySizeBytes: NumericObservation;
  providerDetails?: SourceProjectProviderDetails;
}

export interface SourceInventoryProgress {
  provider: SourceProvider;
  namespace: string;
  discovered: number;
  page: number;
}

export interface SourceNamespaceInventory {
  version: 1;
  provider: SourceProvider;
  sourceApiUrl: string;
  namespace: string;
  projectCount: NumericObservation;
  projects: SourceProjectInventory[];
}

export type ProfileNumericObservation =
  | {
      kind: "exact";
      value: number;
      basis: "reported" | "enumerated";
      scope: string;
    }
  | {
      kind: "at-least";
      value: number;
      reason: "item-cap" | "page-cap" | "request-budget" | "pagination-uncertain";
      scope: string;
    }
  | {
      kind: "unavailable";
      reason: ObservationUnavailableReason;
      scope: string;
    };

export interface ProfileNumericMetric {
  provider: SourceProvider;
  endpointFamily: string;
  collectedAt: string;
  observation: ProfileNumericObservation;
}

export interface GitLabProjectMetrics {
  issues: ProfileNumericMetric;
  mergeRequests: ProfileNumericMetric;
  commits: ProfileNumericMetric;
  branches: ProfileNumericMetric;
  tags: ProfileNumericMetric;
  releases: ProfileNumericMetric;
}

export interface GitLabProfileEnrichment {
  version: 2;
  provider: "gitlab";
  sourceApiUrl: string;
  namespace: string;
  projects: Array<{ sourceId: string; path: string; metrics: GitLabProjectMetrics }>;
}

export interface BitbucketProjectMetrics {
  commits: ProfileNumericMetric;
  pullRequests: ProfileNumericMetric;
  branches: ProfileNumericMetric;
  tags: ProfileNumericMetric;
  forks: ProfileNumericMetric;
}

export interface BitbucketActivity {
  defaultBranch: string | null;
  tipCommittedAt: string | null;
  review: {
    open: number;
    merged: number;
    declined: number;
    oldestOpenCreatedAt: string | null;
    latestUpdatedAt: string | null;
  } | null;
}

export interface BitbucketProfileEnrichment {
  version: 2;
  provider: "bitbucket-server";
  sourceApiUrl: string;
  namespace: string;
  projects: Array<{
    sourceId: string;
    path: string;
    metrics: BitbucketProjectMetrics;
    activity: BitbucketActivity;
  }>;
}
