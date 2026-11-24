import { getDb } from "$lib/server/core/db";
import { type GhesImportJob, type GhesImportJobPhase, isGhesImportJobPhase } from "../ghes/job";

const IMPORT_JOB_COLS = `id, migration_id, phase, exporter_job_id, archive_path,
	archive_sha256, ghes_import_id, source_was_archived, failure_reason, created_at, updated_at`;

function rowToGhesImportJob(row: Record<string, unknown>): GhesImportJob {
  const id = row.id;
  if (typeof id !== "string") throw new Error("Invalid GHES import job row: missing id");
  if (typeof row.migration_id !== "string") {
    throw new Error(`Invalid GHES import job row ${id}: missing migration_id`);
  }
  if (!isGhesImportJobPhase(row.phase)) {
    throw new Error(`Invalid GHES import job row ${id}: invalid phase`);
  }
  if (typeof row.created_at !== "string" || typeof row.updated_at !== "string") {
    throw new Error(`Invalid GHES import job row ${id}: missing timestamps`);
  }

  return {
    id,
    migrationId: row.migration_id,
    phase: row.phase,
    exporterJobId: typeof row.exporter_job_id === "string" ? row.exporter_job_id : null,
    archivePath: typeof row.archive_path === "string" ? row.archive_path : null,
    archiveSha256: typeof row.archive_sha256 === "string" ? row.archive_sha256 : null,
    ghesImportId: typeof row.ghes_import_id === "string" ? row.ghes_import_id : null,
    sourceWasArchived:
      row.source_was_archived === 0 ? false : row.source_was_archived === 1 ? true : null,
    failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertGhesImportJob(job: GhesImportJob): void {
  getDb()
    .prepare(
      `INSERT INTO ghes_import_jobs (${IMPORT_JOB_COLS})
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.id,
      job.migrationId,
      job.phase,
      job.exporterJobId,
      job.archivePath,
      job.archiveSha256,
      job.ghesImportId,
      job.sourceWasArchived === null ? null : job.sourceWasArchived ? 1 : 0,
      job.failureReason,
      job.createdAt,
      job.updatedAt,
    );
}

export function getGhesImportJob(id: string): GhesImportJob | null {
  const row = getDb()
    .prepare(`SELECT ${IMPORT_JOB_COLS} FROM ghes_import_jobs WHERE id = ?`)
    .get(id) as Record<string, unknown> | null;
  return row ? rowToGhesImportJob(row) : null;
}

export function getGhesImportJobByMigrationId(migrationId: string): GhesImportJob | null {
  const row = getDb()
    .prepare(`SELECT ${IMPORT_JOB_COLS} FROM ghes_import_jobs WHERE migration_id = ?`)
    .get(migrationId) as Record<string, unknown> | null;
  return row ? rowToGhesImportJob(row) : null;
}

export function deleteGhesImportJob(id: string): boolean {
  return getDb().prepare("DELETE FROM ghes_import_jobs WHERE id = ?").run(id).changes === 1;
}

export function updateGhesImportJobCheckpoint(
  id: string,
  phase: GhesImportJobPhase,
  extras: {
    exporterJobId?: string;
    archivePath?: string;
    archiveSha256?: string;
    ghesImportId?: string;
    sourceWasArchived?: boolean;
    failureReason?: string;
  } = {},
  updatedAt: string = new Date().toISOString(),
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE ghes_import_jobs SET
				 phase = $phase,
				 exporter_job_id = COALESCE($exporter_job_id, exporter_job_id),
				 archive_path = COALESCE($archive_path, archive_path),
				 archive_sha256 = COALESCE($archive_sha256, archive_sha256),
				 ghes_import_id = COALESCE($ghes_import_id, ghes_import_id),
				 source_was_archived = COALESCE($source_was_archived, source_was_archived),
				 failure_reason = $failure_reason,
				 updated_at = $updated_at
			 WHERE id = $id`,
    )
    .run({
      $id: id,
      $phase: phase,
      $exporter_job_id: extras.exporterJobId ?? null,
      $archive_path: extras.archivePath ?? null,
      $archive_sha256: extras.archiveSha256 ?? null,
      $ghes_import_id: extras.ghesImportId ?? null,
      $source_was_archived:
        extras.sourceWasArchived === undefined ? null : extras.sourceWasArchived ? 1 : 0,
      $failure_reason: extras.failureReason ?? null,
      $updated_at: updatedAt,
    });
  return result.changes === 1;
}

export function getRecoverableGhesImportJobs(): GhesImportJob[] {
  const rows = getDb()
    .prepare(
      `SELECT ${IMPORT_JOB_COLS} FROM ghes_import_jobs
			 WHERE phase NOT IN ('succeeded', 'failed', 'cancelled', 'reconciliation_required')
			 ORDER BY created_at, id`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToGhesImportJob);
}
