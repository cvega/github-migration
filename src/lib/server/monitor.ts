/**
 * Monitor polls the GHEC migration status and target repository to provide
 * real-time progress. Emits events via a callback that the manager wires
 * to SSE + SQLite.
 *
 * Port of pkg/monitor/monitor.go
 */
import { sleep } from "$lib/server/util";
import type {
  Counts,
  Phase,
  Snapshot,
  Progress,
  FailureDetail,
  LogEntry,
  MigrationEvent,
} from "$lib/types";
import {
  getMigration as getGhecMigration,
  getRepoCounts,
  doesRepoExist,
  type GitHubClients,
} from "./github";

export type EventEmitter = (event: MigrationEvent) => void;

export interface MonitorConfig {
  clients: GitHubClients;
  migrationId: string; // internal UUID
  githubMigrationId: string; // GHEC node ID
  targetOrg: string;
  targetRepo: string;
  sourceOrg?: string;
  sourceRepo?: string;
  pollInterval?: number; // ms, default 60_000
  signal?: AbortSignal;
  emit: EventEmitter;
}

export async function runMonitor(cfg: MonitorConfig): Promise<Phase> {
  const interval = cfg.pollInterval ?? 60_000;
  const startTime = Date.now();
  let previous: Snapshot | null = null;
  let lastPhase: Phase | null = null;
  let terminalPhase: Phase = "UNKNOWN";

  // Fetch source counts once as baseline for progress %.
  let sourceCounts: Counts | null = null;
  if (cfg.sourceOrg && cfg.sourceRepo) {
    try {
      sourceCounts = await getRepoCounts(
        cfg.clients.source,
        cfg.sourceOrg,
        cfg.sourceRepo,
      );
      cfg.emit({
        migrationId: cfg.migrationId,
        eventType: "step",
        phase: null,
        payload: { message: "Source counts fetched", counts: sourceCounts },
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Non-fatal — percentages just won't be available.
    }
  }

  const poll = async (): Promise<boolean> => {
    const snapshot = await takeSnapshot(cfg, startTime, sourceCounts);

    const progress = computeProgress(snapshot, previous);

    // Detect phase transitions.
    if (lastPhase && snapshot.phase !== lastPhase) {
      cfg.emit({
        migrationId: cfg.migrationId,
        eventType: "phase_change",
        phase: snapshot.phase,
        payload: { from: lastPhase, to: snapshot.phase },
        createdAt: new Date().toISOString(),
      });
    }
    lastPhase = snapshot.phase;

    // Terminal: succeeded.
    if (snapshot.phase === "SUCCEEDED") {
      cfg.emit({
        migrationId: cfg.migrationId,
        eventType: "complete",
        phase: "SUCCEEDED",
        payload: {
          progress,
          sourceCounts,
          elapsed: (Date.now() - startTime) / 1000,
        },
        createdAt: new Date().toISOString(),
      });
      previous = snapshot;
      terminalPhase = "SUCCEEDED";
      return true;
    }

    // Terminal: failed.
    if (snapshot.phase === "FAILED") {
      const detail = await fetchFailureDetail(cfg, snapshot, startTime);
      cfg.emit({
        migrationId: cfg.migrationId,
        eventType: "failure",
        phase: "FAILED",
        payload: { progress, detail },
        createdAt: new Date().toISOString(),
      });
      previous = snapshot;
      terminalPhase = "FAILED";
      return true;
    }

    // Regular snapshot.
    cfg.emit({
      migrationId: cfg.migrationId,
      eventType: "snapshot",
      phase: snapshot.phase,
      payload: { progress, sourceCounts },
      createdAt: new Date().toISOString(),
    });

    previous = snapshot;
    return false;
  };

  // Immediate first poll.
  if (await poll()) return terminalPhase;

  // Tick loop.
  while (!cfg.signal?.aborted) {
    await sleep(interval, cfg.signal);
    if (cfg.signal?.aborted) break;
    try {
      if (await poll()) return terminalPhase;
    } catch (err) {
      console.warn("Monitor poll error — will retry", err);
    }
  }

  return terminalPhase;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

async function takeSnapshot(
  cfg: MonitorConfig,
  startTime: number,
  sourceCounts: Counts | null,
): Promise<Snapshot> {
  const ghMig = await getGhecMigration(
    cfg.clients.targetGraphql,
    cfg.githubMigrationId,
  );

  const repoExists = await doesRepoExist(
    cfg.clients.target,
    cfg.targetOrg,
    cfg.targetRepo,
  );

  let counts: Counts = {
    commits: 0,
    branches: 0,
    tags: 0,
    issues: 0,
    pullRequests: 0,
    releases: 0,
  };
  if (repoExists) {
    try {
      counts = await getRepoCounts(
        cfg.clients.target,
        cfg.targetOrg,
        cfg.targetRepo,
      );
    } catch {
      // Non-fatal
    }
  }

  const phase = detectPhase(ghMig.state, repoExists, counts, sourceCounts);

  const snap: Snapshot = {
    timestamp: new Date().toISOString(),
    migrationState: ghMig.state,
    failureReason: ghMig.failureReason || "",
    migrationLogUrl: ghMig.migrationLogUrl || "",
    warningsCount: ghMig.warningsCount,
    repoExists,
    repoSize: 0,
    commits: counts.commits,
    branches: counts.branches,
    tags: counts.tags,
    issues: counts.issues,
    pullRequests: counts.pullRequests,
    releases: counts.releases,
    phase,
    elapsed: (Date.now() - startTime) / 1000,
  };

  return snap;
}

// ── Phase detection (port of pkg/monitor/phase.go) ──────────────────────────

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
      if (counts.issues > 0 || counts.pullRequests > 0)
        return "IMPORTING_METADATA";
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

// ── Progress computation ────────────────────────────────────────────────────

function computeProgress(current: Snapshot, prev: Snapshot | null): Progress {
  const p: Progress = {
    current,
    previous: prev,
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

  if (prev) {
    p.deltaCommits = current.commits - prev.commits;
    p.deltaBranches = current.branches - prev.branches;
    p.deltaTags = current.tags - prev.tags;
    p.deltaIssues = current.issues - prev.issues;
    p.deltaPRs = current.pullRequests - prev.pullRequests;
    p.deltaReleases = current.releases - prev.releases;
    p.deltaSize = current.repoSize - prev.repoSize;

    const elapsedMin =
      (new Date(current.timestamp).getTime() -
        new Date(prev.timestamp).getTime()) /
      60_000;
    if (elapsedMin > 0 && p.deltaCommits > 0) {
      p.commitsPerMin = p.deltaCommits / elapsedMin;
    }
    if (elapsedMin > 0 && p.deltaIssues > 0) {
      p.issuesPerMin = p.deltaIssues / elapsedMin;
    }
  }

  return p;
}

// ── Failure detail ──────────────────────────────────────────────────────────

async function fetchFailureDetail(
  cfg: MonitorConfig,
  snap: Snapshot,
  startTime: number,
): Promise<FailureDetail> {
  const detail: FailureDetail = {
    migrationId: cfg.migrationId,
    state: snap.migrationState,
    failureReason: snap.failureReason,
    elapsed: (Date.now() - startTime) / 1000,
    logUrl: snap.migrationLogUrl,
    logEntries: [],
  };

  if (snap.migrationLogUrl) {
    try {
      const token = await cfg.clients.getTargetToken();
      const resp = await fetch(snap.migrationLogUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        detail.logEntries = (await resp.json()) as LogEntry[];
      }
    } catch {
      // Non-fatal
    }
  }

  return detail;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Re-export shared sleep utility.
export { sleep } from "$lib/server/util";
