import type {
  Counts,
  FailureDetail,
  LogEntry,
  MigrationEvent,
  Phase,
  Progress,
  Snapshot,
} from "$lib/migrate/types";
import { doesRepoExist, type GitHubClients, getRepoCounts } from "$lib/server/core/github";
import { pollWithRetry, sleep } from "$lib/server/core/polling";
import { getRepositoryMigration } from "./migration-source";

const defaultDependencies = {
  doesRepoExist,
  fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  getRepoCounts,
  getRepositoryMigration,
  wait: sleep,
};
let dependencies = { ...defaultDependencies };

export function __setMonitorDependenciesForTests(
  overrides: Partial<typeof defaultDependencies>,
): () => void {
  dependencies = { ...defaultDependencies, ...overrides };
  return () => {
    dependencies = { ...defaultDependencies };
  };
}

export type MigrationEventEmitter = (event: MigrationEvent) => void;

export interface MonitorConfig {
  clients: GitHubClients;
  migrationId: string;
  githubMigrationId: string;
  targetOrg: string;
  targetRepo: string;
  sourceOrg?: string;
  sourceRepo?: string;
  sourceCounts?: Counts | null;
  pollInterval?: number;
  signal?: AbortSignal;
  emit: MigrationEventEmitter;
}

export interface MonitorResult {
  phase: Phase;
  finalCounts: Counts | null;
}

function snapshotToCounts(snapshot: Snapshot): Counts {
  return {
    commits: snapshot.commits,
    branches: snapshot.branches,
    tags: snapshot.tags,
    issues: snapshot.issues,
    pullRequests: snapshot.pullRequests,
    releases: snapshot.releases,
  };
}

export async function monitorRepositoryMigration(config: MonitorConfig): Promise<MonitorResult> {
  const interval = config.pollInterval ?? 60_000;
  const startTime = Date.now();
  let previous: Snapshot | null = null;
  let lastPhase: Phase | null = null;
  let terminalPhase: Phase = "UNKNOWN";
  let finalCounts: Counts | null = null;
  let lastAuthoritativeCounts: Counts | null = null;
  let sourceCounts: Counts | null = config.sourceCounts ?? null;

  if (!sourceCounts && config.sourceOrg && config.sourceRepo) {
    try {
      sourceCounts = await dependencies.getRepoCounts(
        config.clients.source,
        config.clients.sourceGraphql,
        config.sourceOrg,
        config.sourceRepo,
      );
      config.emit({
        migrationId: config.migrationId,
        eventType: "step",
        phase: null,
        payload: { message: "Source counts fetched", counts: sourceCounts },
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Source percentages are optional.
    }
  }

  const poll = async (): Promise<boolean> => {
    const snapshot = await takeSnapshot(config, startTime, sourceCounts);
    if (snapshot.countsAuthoritative) lastAuthoritativeCounts = snapshotToCounts(snapshot);
    const progress = computeProgress(snapshot, previous);
    if (lastPhase && snapshot.phase !== lastPhase) {
      config.emit({
        migrationId: config.migrationId,
        eventType: "phase_change",
        phase: snapshot.phase,
        payload: { from: lastPhase, to: snapshot.phase },
        createdAt: new Date().toISOString(),
      });
    }
    lastPhase = snapshot.phase;

    if (snapshot.phase === "SUCCEEDED") {
      config.emit({
        migrationId: config.migrationId,
        eventType: "complete",
        phase: "SUCCEEDED",
        payload: { progress, sourceCounts, elapsed: (Date.now() - startTime) / 1_000 },
        createdAt: new Date().toISOString(),
      });
      previous = snapshot;
      terminalPhase = "SUCCEEDED";
      finalCounts = lastAuthoritativeCounts;
      return true;
    }
    if (snapshot.phase === "FAILED") {
      const detail = await fetchFailureDetail(config, snapshot, startTime);
      config.emit({
        migrationId: config.migrationId,
        eventType: "failure",
        phase: "FAILED",
        payload: { progress, detail },
        createdAt: new Date().toISOString(),
      });
      previous = snapshot;
      terminalPhase = "FAILED";
      return true;
    }
    config.emit({
      migrationId: config.migrationId,
      eventType: "snapshot",
      phase: snapshot.phase,
      payload: { progress, sourceCounts },
      createdAt: new Date().toISOString(),
    });
    previous = snapshot;
    return false;
  };

  const maxConsecutiveErrors = 10;
  try {
    await pollWithRetry({
      poll,
      wait: () => dependencies.wait(interval, config.signal),
      shouldStop: () => config.signal?.aborted ?? false,
      maxConsecutiveErrors,
      onError: (error, consecutiveErrors) => {
        console.warn(
          `Monitor poll error (${consecutiveErrors}/${maxConsecutiveErrors}) - will retry`,
          error,
        );
      },
    });
  } catch (error) {
    throw new Error(
      `Monitor: ${maxConsecutiveErrors} consecutive poll failures - aborting. Last error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { phase: terminalPhase, finalCounts };
}

async function takeSnapshot(
  config: MonitorConfig,
  startTime: number,
  sourceCounts: Counts | null,
): Promise<Snapshot> {
  const migration = await dependencies.getRepositoryMigration(
    config.clients.targetGraphql,
    config.githubMigrationId,
  );
  const repoExists = await dependencies.doesRepoExist(
    config.clients.target,
    config.targetOrg,
    config.targetRepo,
  );
  let counts: Counts = {
    commits: 0,
    branches: 0,
    tags: 0,
    issues: 0,
    pullRequests: 0,
    releases: 0,
  };
  let countsAuthoritative = false;
  if (repoExists) {
    try {
      counts = await dependencies.getRepoCounts(
        config.clients.target,
        config.clients.targetGraphql,
        config.targetOrg,
        config.targetRepo,
      );
      countsAuthoritative = true;
    } catch {
      // Counts become authoritative on a later successful poll.
    }
  }
  return {
    timestamp: new Date().toISOString(),
    migrationState: migration.state,
    failureReason: migration.failureReason || "",
    migrationLogUrl: migration.migrationLogUrl || "",
    warningsCount: migration.warningsCount,
    repoExists,
    countsAuthoritative,
    repoSize: 0,
    ...counts,
    phase: detectPhase(migration.state, repoExists, counts, sourceCounts),
    elapsed: (Date.now() - startTime) / 1_000,
  };
}

function detectPhase(
  migrationState: string,
  repoExists: boolean,
  counts: Counts,
  sourceCounts: Counts | null,
): Phase {
  switch (migrationState) {
    case "QUEUED":
      return "QUEUED";
    case "PENDING_VALIDATION":
      return "PENDING_VALIDATION";
    case "FAILED":
    case "FAILED_VALIDATION":
      return "FAILED";
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "IN_PROGRESS":
      if (!repoExists) return "EXPORTING";
      if (counts.issues > 0 || counts.pullRequests > 0) return "IMPORTING_METADATA";
      if (
        sourceCounts &&
        sourceCounts.commits > 0 &&
        counts.commits >= sourceCounts.commits &&
        counts.branches >= sourceCounts.branches
      ) {
        return "IMPORTING_METADATA";
      }
      return "IMPORTING_GIT";
    default:
      return "UNKNOWN";
  }
}

function computeProgress(current: Snapshot, previous: Snapshot | null): Progress {
  const progress: Progress = {
    current,
    previous,
    deltaCommits: 0,
    deltaBranches: 0,
    deltaTags: 0,
    deltaIssues: 0,
    deltaPRs: 0,
    deltaReleases: 0,
    deltaSize: 0,
    commitsPerMin: 0,
    issuesPerMin: 0,
  };
  if (previous) {
    progress.deltaCommits = current.commits - previous.commits;
    progress.deltaBranches = current.branches - previous.branches;
    progress.deltaTags = current.tags - previous.tags;
    progress.deltaIssues = current.issues - previous.issues;
    progress.deltaPRs = current.pullRequests - previous.pullRequests;
    progress.deltaReleases = current.releases - previous.releases;
    progress.deltaSize = current.repoSize - previous.repoSize;
    const elapsedMinutes =
      (new Date(current.timestamp).getTime() - new Date(previous.timestamp).getTime()) / 60_000;
    if (elapsedMinutes > 0 && progress.deltaCommits > 0) {
      progress.commitsPerMin = progress.deltaCommits / elapsedMinutes;
    }
    if (elapsedMinutes > 0 && progress.deltaIssues > 0) {
      progress.issuesPerMin = progress.deltaIssues / elapsedMinutes;
    }
  }
  return progress;
}

async function fetchFailureDetail(
  config: MonitorConfig,
  snapshot: Snapshot,
  startTime: number,
): Promise<FailureDetail> {
  const detail: FailureDetail = {
    migrationId: config.migrationId,
    state: snapshot.migrationState,
    failureReason: snapshot.failureReason,
    elapsed: (Date.now() - startTime) / 1_000,
    logUrl: snapshot.migrationLogUrl,
    logEntries: [],
  };
  if (snapshot.migrationLogUrl) {
    try {
      const logUrl = new URL(snapshot.migrationLogUrl);
      const trustedHost =
        logUrl.hostname === "github.com" || logUrl.hostname.endsWith(".github.com");
      if (
        logUrl.protocol !== "https:" ||
        logUrl.username !== "" ||
        logUrl.password !== "" ||
        logUrl.port !== "" ||
        !trustedHost
      ) {
        console.warn("[monitor] Refusing to fetch migration log from an untrusted URL");
      } else {
        const token = await config.clients.getTargetToken();
        const response = await dependencies.fetch(logUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) detail.logEntries = (await response.json()) as LogEntry[];
      }
    } catch {
      // Failure logs are supplementary.
    }
  }
  return detail;
}
