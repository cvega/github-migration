/** Migration contracts shared by routes, browser modules, and server execution. */
import type { SourceProvider } from "$lib/source/types";
import type { TargetPlatform } from "$lib/target-platform";

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

/** Hard cap on page size to bound query/response cost. */
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_NUMBER = 1_000_000;

function parseIntegerParam(value: string | null, fallback: number): number {
  if (value === null || !/^-?\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * Parse `?page=` and `?limit=` from a URLSearchParams into safe, clamped
 * PaginationParams (page ≥ 1; 1 ≤ limit ≤ MAX_PAGE_SIZE). Invalid/missing
 * values fall back to defaults. Shared by every paginated load/endpoint.
 */
export function parsePaginationParams(searchParams: URLSearchParams): PaginationParams {
  const page = Math.min(
    MAX_PAGE_NUMBER,
    Math.max(1, parseIntegerParam(searchParams.get("page"), 1)),
  );
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseIntegerParam(searchParams.get("limit"), DEFAULT_PAGE_SIZE)),
  );
  return { page, limit };
}

// ── Migration types ────────────────────────────────────────────────────────

export type MigrationState =
  | "queued"
  | "pending"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "reconciliation_required";

export type PipelineStep =
  | "preflight"
  | "source_export"
  | "source_export_ready"
  | "archive_upload"
  | "archiving"
  | "ghec_starting"
  | "monitoring"
  | "post_migration";

export type AuthMode = "request-pat" | "request-app" | "env-app" | "env-pat";

/** Auth selection in the UI auth-mode toggle (PAT, request-time App, or server env). */
export type AuthFieldMode = "pat" | "app" | "env-app" | "env-pat";

export const MIGRATION_PHASES = [
  "QUEUED",
  "PENDING_VALIDATION",
  "EXPORTING",
  "IMPORTING_GIT",
  "IMPORTING_METADATA",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
] as const;

export type Phase = (typeof MIGRATION_PHASES)[number];

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
  countsAuthoritative: boolean;
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

interface StepPayload {
  confirmedInactive?: true;
  message: string;
  executorPhase?: string;
  counts?: Counts;
  postTerminal?: {
    operation: "source_archive";
    outcome: "succeeded" | "failed" | "not_attempted";
  };
}

interface PhaseChangePayload {
  from: Phase;
  to: Phase;
}

interface SnapshotPayload {
  progress: Progress;
  sourceCounts: Counts | null;
}

interface CompletePayload {
  progress: Progress;
  sourceCounts: Counts | null;
  elapsed: number;
}

interface FailurePayload {
  error?: string;
  progress?: Progress;
  detail?: FailureDetail;
}

/** Maps each EventType to its typed payload. */
interface MigrationEventPayloadMap {
  banner: { message: string };
  step: StepPayload;
  phase_change: PhaseChangePayload;
  milestone: { message: string };
  snapshot: SnapshotPayload;
  complete: CompletePayload;
  failure: FailurePayload;
  restart: { message: string; previousState: "failed" | "cancelled" };
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

/** Notification-feed kinds, derived from the underlying event type. */
export type ActivityKind = "succeeded" | "failed" | "restarted" | "notice";

/**
 * A single entry in the recent-activity notification feed. Flattens a
 * lifecycle event joined with its migration's repo identity, so the navbar
 * bell can render "org/repo — <summary>" without extra lookups.
 */
export interface ActivityItem {
  /** Underlying event row id (monotonic; used for unread tracking). */
  id: number;
  migrationId: string;
  kind: ActivityKind;
  /** "source_org/source_repo". */
  repo: string;
  /** Human-readable detail (failure reason, restart message, or ""). */
  summary: string;
  createdAt: string;
}

export interface Migration {
  /** Absent for administrator, legacy and seeded migrations. */
  ownerUserId?: string;
  /** Includes conflicting legacy target fields and durable GHES checkpoints. */
  routeExecutionPaused?: true;
  id: string;
  batchId: string | null;
  githubMigrationId: string | null;
  sourceProvider: SourceProvider;
  sourceApiUrl: string;
  targetProfileId: string;
  targetPlatform: TargetPlatform;
  targetApiUrl: string;
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
  /** Source repository disk size in KB (from the GitHub API), or null if unknown. */
  sourceSizeKb: number | null;
  startedAt: string;
  completedAt: string | null;
  elapsedSeconds: number | null;
  authMode: AuthMode | null;
  requestOptions: string | null;
}

/** Aggregate analytics across all migrations, for the /stats dashboard. */
export interface MigrationDirectionStats {
  sourceProvider: SourceProvider;
  /** GitHub deployment type; native providers are identified by sourceProvider. */
  githubSourcePlatform: TargetPlatform | null;
  targetPlatform: TargetPlatform;
  total: number;
  finished: number;
  outcomes: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  rate: number;
  duration: {
    avgSeconds: number | null;
    medianSeconds: number | null;
    p95Seconds: number | null;
    timedCount: number;
    eligibleCount: number;
  };
}

interface MigrationFailureStats {
  reason: string;
  latestMigrationId: string;
  latestRunAt: string;
  count: number;
  share: number;
  avgSeconds: number | null;
  totalSeconds: number | null;
  timedCount: number;
}

interface MigrationSizeStats {
  band: import("$lib/repository-size").RepositorySizeBand;
  outcomes: number;
  succeeded: number;
  failed: number;
  rate: number;
  duration: {
    medianSeconds: number | null;
    p95Seconds: number | null;
    timedCount: number;
    eligibleCount: number;
  };
}

interface MigrationBatchStats {
  id: string;
  total: number;
  completed: number;
  completionRate: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  needsReview: number;
  active: boolean;
  needsAttention: boolean;
  elapsedSeconds: number | null;
  startedAt: string;
}

export type MigrationStatsPeriod = "30d" | "90d" | "all";
export type MigrationStatsMode = "single" | "batch" | "all";

export interface MigrationStatsFilters {
  period: MigrationStatsPeriod;
  sourceProvider: SourceProvider | "all";
  targetPlatform: TargetPlatform | "all";
  mode: MigrationStatsMode;
}

export interface MigrationStats {
  total: number;
  byState: Record<MigrationState, number>;
  /** Finished migrations (succeeded + failed + cancelled). */
  finished: number;
  /** Migrations that either succeeded or failed. */
  outcomes: number;
  /** Migrations that succeeded, failed, or were cancelled. */
  resolved: number;
  /** Migrations currently queued, pending, running, or cancelling. */
  active: number;
  /** Migrations awaiting reconciliation. */
  needsReview: number;
  /** Success rate over succeeded and failed migrations, or null without outcomes. */
  successRate: number | null;
  /** Cancellation rate over resolved migrations, 0–100. */
  cancellationRate: number;
  duration: {
    avgSeconds: number | null;
    medianSeconds: number | null;
    p95Seconds: number | null;
    totalSeconds: number;
    minSeconds: number | null;
    maxSeconds: number | null;
    timedCount: number;
    eligibleCount: number;
  };
  data: {
    totalKb: number;
    avgKb: number | null;
    largestKb: number | null;
    largestRepo: string | null;
    sizedCount: number;
    eligibleCount: number;
  };
  resources: Counts & { migrationCount: number };
  /** Counts and outcomes grouped by persisted migration path identity. */
  directions: MigrationDirectionStats[];
  warnings: {
    total: number;
    withWarnings: number;
  };
  /** Fastest and slowest succeeded migrations. */
  records: {
    fastest: { repo: string; seconds: number } | null;
    slowest: { repo: string; seconds: number } | null;
  };
  /** Top source organizations by migration attempts, separated by provider and host. */
  topOrgs: Array<{ key: string; org: string; provider: string; host: string; count: number }>;
  failuresByReason: MigrationFailureStats[];
  failuresWithoutReason: number;
  batchFailures: number;
  sizeStats: MigrationSizeStats[];
  sizeUnavailableCount: number;
  batchStats: MigrationBatchStats[];
  /** Completions grouped into UTC calendar intervals, oldest first. */
  throughput: Array<{ date: string; endDate: string; succeeded: number; failed: number }>;
  throughputIntervalDays: number;
  /** Seven UTC calendar days ending today, excluding future completions. */
  recentWindow: {
    endingOn: string | null;
    completed: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
    previousCompleted: number;
    volumeChangePct: number | null;
  };
  batches: number;
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

/**
 * Credentials and per-migration option flags shared by every migration request
 * (create, batch, and restart). The concrete request types extend this with
 * the fields unique to each (e.g. `sourceRepo`, `repos`).
 */
export interface MigrationOptions {
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

export interface CreateMigrationRequest extends MigrationOptions {
  sourceProvider?: SourceProvider;
  sourceApiUrl?: string;
  targetProfileId?: string;
  sourceRepo: string;
  targetOrg: string;
  targetRepo?: string;
  gitArchivePath?: string;
  metadataArchivePath?: string;
}

/**
 * Restart request — repo info comes from the existing DB row, so the user only
 * provides credentials and options (exactly {@link MigrationOptions}).
 */
export type RestartMigrationRequest = MigrationOptions;

interface BatchMigrationItem {
  sourceRepo: string;
  targetRepo: string;
}

export interface BatchMigrationRequest extends MigrationOptions {
  profileRunId?: string;
  sourceProvider?: SourceProvider;
  sourceApiUrl?: string;
  targetProfileId: string;
  repos?: string[];
  items?: BatchMigrationItem[];
  targetOrg: string;
}

export interface BatchListItem {
  id: string;
  sourceProvider: SourceProvider;
  sourceApiUrl: string;
  targetPlatform: TargetPlatform;
  mixedRoute: boolean;
  totalCount: number;
  queuedCount: number;
  pendingCount: number;
  runningCount: number;
  cancellingCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  reconciliationRequiredCount: number;
  startedAt: string;
}

export interface BatchSummary extends BatchListItem {
  migrations: Migration[];
}
