/**
 * Builds the plain-text "failure report" a user can copy to share migration
 * context with a services engineer. Shared by the migration card and the
 * failure-detail panel so the format stays identical.
 */
import { formatDateTime, formatElapsed, formatRepoSize } from "$lib/format";
import type { Migration } from "$lib/types";

/**
 * The shared header block: repo identity, IDs, timing, auth, and failure
 * reason. Callers may append extra sections (errors, warnings, event log).
 */
export function buildMigrationReportLines(m: Migration): string[] {
  return [
    "GitHub Migration — Failure Report",
    "==================================",
    `Source repo:        ${m.sourceOrg}/${m.sourceRepo}`,
    `Target repo:        ${m.targetOrg}/${m.targetRepo}`,
    `Source API URL:     ${m.sourceApiUrl}`,
    `Migration ID:       ${m.id}`,
    `GHEC migration ID:  ${m.githubMigrationId ?? "(not assigned)"}`,
    `Batch ID:           ${m.batchId ?? "(none)"}`,
    `State:              ${m.state}`,
    `Failure reason:     ${m.failureReason ?? "(none)"}`,
    `Started:            ${formatDateTime(m.startedAt)}`,
    `Completed:          ${m.completedAt ? formatDateTime(m.completedAt) : "(n/a)"}`,
    `Elapsed:            ${formatElapsed(m.elapsedSeconds)}`,
    `Source size:        ${m.sourceSizeKb != null ? formatRepoSize(m.sourceSizeKb) : "(unknown)"}`,
    `Auth mode:          ${m.authMode ?? "(unknown)"}`,
    `Warnings:           ${m.warningsCount}`,
    `Migration log:      ${m.migrationLogUrl ?? "(none)"}`,
  ];
}

/** Convenience: the header block joined into a ready-to-copy string. */
export function buildMigrationReport(m: Migration): string {
  return buildMigrationReportLines(m).join("\n");
}
