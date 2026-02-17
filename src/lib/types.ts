/** Shared types used by both frontend and server. */

// ── Pagination ─────────────────────────────────────────────────────────────

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const DEFAULT_PAGE_SIZE = 25;

// ── Migration types ────────────────────────────────────────────────────────

export type MigrationState =
  | "queued"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type PipelineStep =
  | "preflight"
  | "archiving"
  | "ghec_starting"
  | "monitoring"
  | "post_migration";

export type AuthMode = "pat" | "request-app" | "env-app" | "env-pat";

export type Phase =
  | "QUEUED"
  | "PENDING_VALIDATION"
  | "EXPORTING"
  | "IMPORTING_GIT"
  | "IMPORTING_METADATA"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN";

export type EventType =
  | "banner"
  | "step"
  | "phase_change"
  | "milestone"
  | "snapshot"
  | "complete"
  | "failure"
  | "restart";

export interface Counts {
  commits: number;
  branches: number;
  tags: number;
  issues: number;
  pullRequests: number;
  releases: number;
}

export interface Snapshot {
  timestamp: string;
  migrationState: string;
  failureReason: string;
  migrationLogUrl: string;
  warningsCount: number;
  repoExists: boolean;
  repoSize: number;
  commits: number;
  branches: number;
  tags: number;
  issues: number;
  pullRequests: number;
  releases: number;
  phase: Phase;
  elapsed: number;
}

export interface Progress {
  current: Snapshot;
  previous: Snapshot | null;
  deltaCommits: number;
  deltaBranches: number;
  deltaTags: number;
  deltaIssues: number;
  deltaPRs: number;
  deltaReleases: number;
  deltaSize: number;
  commitsPerMin: number;
  issuesPerMin: number;
}

export interface LogEntry {
  severity: string;
  message: string;
  modelName: string;
}

export interface FailureDetail {
  migrationId: string;
  state: string;
  failureReason: string;
  elapsed: number;
  logUrl: string;
  logEntries: LogEntry[];
}

// ── Event payload types ────────────────────────────────────────────────────

export interface StepPayload {
  message: string;
  counts?: Counts;
}

export interface PhaseChangePayload {
  from: Phase;
  to: Phase;
}

export interface SnapshotPayload {
  progress: Progress;
  sourceCounts: Counts | null;
}

export interface CompletePayload {
  progress: Progress;
  sourceCounts: Counts | null;
  elapsed: number;
}

export interface FailurePayload {
  error?: string;
  progress?: Progress;
  detail?: FailureDetail;
}

/** Maps each EventType to its typed payload. */
export interface MigrationEventPayloadMap {
  banner: { message: string };
  step: StepPayload;
  phase_change: PhaseChangePayload;
  milestone: { message: string };
  snapshot: SnapshotPayload;
  complete: CompletePayload;
  failure: FailurePayload;
  restart: { message: string };
}

/** Base shape shared by all migration events. */
interface MigrationEventBase<T extends EventType> {
  id?: number;
  migrationId: string;
  eventType: T;
  phase: Phase | null;
  payload: MigrationEventPayloadMap[T];
  createdAt: string;
}

/** Discriminated union — narrow on `eventType` to get typed `payload`. */
export type MigrationEvent = {
  [K in EventType]: MigrationEventBase<K>;
}[EventType];

export interface Migration {
  id: string;
  batchId: string | null;
  githubMigrationId: string | null;
  sourceApiUrl: string;
  sourceOrg: string;
  sourceRepo: string;
  targetOrg: string;
  targetRepo: string;
  state: MigrationState;
  failureReason: string | null;
  migrationLogUrl: string | null;
  warningsCount: number;
  sourceCounts: Counts | null;
  targetCounts: Counts | null;
  startedAt: string;
  completedAt: string | null;
  elapsedSeconds: number | null;
  authMode: AuthMode | null;
  requestOptions: string | null;
}

export interface AppAuth {
  appId: string;
  privateKey: string;
  installationId: string;
}

/**
 * Authentication input for GitHub API calls.
 * Either a static PAT or GitHub App credentials that enable auto-refresh.
 */
export type AuthInput =
  | { token: string; appId?: undefined }
  | {
      token?: undefined;
      appId: string;
      privateKey: string;
      installationId: number;
    };

export interface CreateMigrationRequest {
  sourceApiUrl?: string;
  sourceRepo: string;
  targetOrg: string;
  targetRepo?: string;
  sourceToken?: string;
  targetToken?: string;
  sourceApp?: AppAuth;
  targetApp?: AppAuth;
  noSslVerify?: boolean;
  skipReleases?: boolean;
  lockSource?: boolean;
  archiveSource?: boolean;
  targetRepoVisibility?: "private" | "public" | "internal";
  directPassthrough?: boolean;
  gitArchivePath?: string;
  metadataArchivePath?: string;
}

/**
 * Restart request — repo info comes from the existing DB row,
 * user only provides credentials and options.
 */
export interface RestartMigrationRequest {
  sourceToken?: string;
  targetToken?: string;
  sourceApp?: AppAuth;
  targetApp?: AppAuth;
  noSslVerify?: boolean;
  skipReleases?: boolean;
  lockSource?: boolean;
  archiveSource?: boolean;
  targetRepoVisibility?: "private" | "public" | "internal";
  directPassthrough?: boolean;
}

export interface BatchMigrationRequest {
  sourceApiUrl?: string;
  repos: string[];
  targetOrg: string;
  sourceToken?: string;
  targetToken?: string;
  sourceApp?: AppAuth;
  targetApp?: AppAuth;
  noSslVerify?: boolean;
  skipReleases?: boolean;
  lockSource?: boolean;
  archiveSource?: boolean;
  targetRepoVisibility?: "private" | "public" | "internal";
  directPassthrough?: boolean;
}

export interface BatchSummary {
  id: string;
  totalCount: number;
  queuedCount: number;
  pendingCount: number;
  runningCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  startedAt: string;
  migrations: Migration[];
}

/** Lightweight batch info for list views — no embedded migrations array. */
export interface BatchListItem {
  id: string;
  totalCount: number;
  queuedCount: number;
  pendingCount: number;
  runningCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  startedAt: string;
}

// ── GitHub Status ──────────────────────────────────────────────────────────

export interface GitHubStatusIncident {
  name: string;
  status: string;
  url: string;
}

export interface GitHubStatus {
  ok: boolean;
  incidentCount: number;
  incidents: GitHubStatusIncident[];
}
