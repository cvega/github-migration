export const GHES_IMPORT_JOB_PHASES = [
  "pending",
  "exporting",
  "archive_ready",
  "transferring",
  "preparing",
  "mapping",
  "importing",
  "auditing",
  "unlocking",
  "succeeded",
  "failed",
  "cancelled",
  "reconciliation_required",
] as const;

export type GhesImportJobPhase = (typeof GHES_IMPORT_JOB_PHASES)[number];

export interface GhesImportJob {
  id: string;
  migrationId: string;
  phase: GhesImportJobPhase;
  exporterJobId: string | null;
  archivePath: string | null;
  archiveSha256: string | null;
  ghesImportId: string | null;
  sourceWasArchived: boolean | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isGhesImportJobPhase(value: unknown): value is GhesImportJobPhase {
  return typeof value === "string" && GHES_IMPORT_JOB_PHASES.includes(value as GhesImportJobPhase);
}

export function requiresManualImportReview(job: GhesImportJob | null): boolean {
  if (!job) return false;
  return (
    job.phase === "importing" ||
    (["mapping", "auditing", "unlocking"].includes(job.phase) && !job.ghesImportId) ||
    (Boolean(job.ghesImportId) &&
      ["failed", "cancelled", "reconciliation_required"].includes(job.phase))
  );
}

export const MANUAL_IMPORT_REVIEW =
  "The GHES import outcome requires manual verification on the appliance. Restart is unavailable for this attempt.";
