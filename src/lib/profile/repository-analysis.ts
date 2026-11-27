import type { ProfilePlanRepo } from "./types";
export type RepositoryAnalysisState =
  | "queued"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type RepositoryAnalysisJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RepositoryAnalysisRun {
  id: string;
  profileRunId: string;
  state: RepositoryAnalysisState;
  policyVersion: number;
  selectedRepoCount: number;
  completedRepoCount: number;
  failedRepoCount: number;
  unknownSizeRepoCount: number;
  estimatedCloneBytes: number;
  estimatedPeakWorkspaceBytes: number;
  startedAt: string;
  completedAt: string | null;
  failureReason: string | null;
}

export interface RepositoryAnalysisJob {
  id: string;
  analysisRunId: string;
  profileRepoId: number;
  nameWithOwner: string;
  state: RepositoryAnalysisJobState;
  priority: number;
  priorityReasons: string[];
  estimatedWorkspaceBytes: number | null;
  attempt: number;
  failureReason: string | null;
  result: RepositoryAnalysisResultSummary | null;
}

interface RepositoryAnalysisResultSummary {
  capturedAt: string;
  mirrorSizeBytes: number;
  lfsPointerCount: number;
  lfsDeclaredBytes: number;
  gitSizerMetrics: GitSizerMetric[];
  gitSizerFindings: GitSizerFinding[];
}

export interface GitSizerMetric {
  metric: string;
  description: string;
  value: number;
  unit: string;
  prefixes: "binary" | "metric";
  referenceValue: number | null;
  levelOfConcern: number;
  objectName: string | null;
  objectDescription: string | null;
}

export interface GitSizerFinding extends GitSizerMetric {
  severity: "warning" | "critical";
}

export function normalizeGitSizerMetrics(metrics: unknown): GitSizerMetric[] {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return [];
  const normalized: GitSizerMetric[] = [];
  for (const [metric, raw] of Object.entries(metrics)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const { description, value, unit, prefixes, levelOfConcern } = candidate;
    if (
      typeof description !== "string" ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      typeof unit !== "string" ||
      (prefixes !== "binary" && prefixes !== "metric") ||
      typeof levelOfConcern !== "number" ||
      !Number.isFinite(levelOfConcern)
    ) {
      continue;
    }
    normalized.push({
      metric,
      description,
      value,
      unit,
      prefixes,
      referenceValue:
        typeof candidate.referenceValue === "number" && Number.isFinite(candidate.referenceValue)
          ? candidate.referenceValue
          : null,
      levelOfConcern,
      objectName: typeof candidate.objectName === "string" ? candidate.objectName : null,
      objectDescription:
        typeof candidate.objectDescription === "string" ? candidate.objectDescription : null,
    });
  }
  return normalized;
}

export function findingsFromGitSizerMetrics(metrics: readonly GitSizerMetric[]): GitSizerFinding[] {
  return metrics
    .filter((metric) => metric.levelOfConcern >= 1)
    .map((metric) => ({
      ...metric,
      severity: metric.levelOfConcern >= 30 ? ("critical" as const) : ("warning" as const),
    }))
    .sort((left, right) => right.levelOfConcern - left.levelOfConcern);
}

export function interpretGitSizerMetrics(metrics: unknown): GitSizerFinding[] {
  return findingsFromGitSizerMetrics(normalizeGitSizerMetrics(metrics));
}

export interface RepositoryAnalysisDetail {
  run: RepositoryAnalysisRun;
  jobs: RepositoryAnalysisJob[];
}

export function requiresRepositoryAnalysis(repo: ProfilePlanRepo): boolean {
  return repo.blockers > 0 || repo.warnings > 0 || repo.incompleteReadinessScan === true;
}

export function repositoryAnalysisAllowsPlanning(
  repo: ProfilePlanRepo,
  analysis: RepositoryAnalysisDetail | null,
): boolean {
  if (!requiresRepositoryAnalysis(repo)) return true;
  return (
    analysis?.jobs.some(
      (job) => job.nameWithOwner === repo.nameWithOwner && job.state === "succeeded",
    ) ?? false
  );
}
