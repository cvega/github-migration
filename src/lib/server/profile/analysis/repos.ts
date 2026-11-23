/**
 * Catalog analysis — runs a repository's signals against the migration catalog
 * and produces a per-repo readiness profile.
 *
 * The catalog (`$lib/profile/migration-catalog`) is the canonical list of
 * what the GitHub export does not carry cleanly. This engine evaluates each entry against
 * the gathered `RepoSignals` and classifies it:
 *
 *   - applies        — the impact is present (with human-readable evidence)
 *   - clear          — evaluated and the impact does not apply
 *   - indeterminate  — the signal this entry needs has not been gathered yet
 *
 * Detectors are keyed by catalog entry **id** (not the entry's `detector`
 * string), because one detector source can back several entries — e.g.
 * `git-sizer` underpins both the commit-size and file-size limits. Only
 * entries whose signals the crawl currently gathers have a detector;
 * everything else is honestly reported as indeterminate until a later crawl
 * pass supplies its signal.
 */
import { MIGRATION_CATALOG, type MigrationCatalogEntry } from "$lib/profile/migration-catalog";
import type { RepoSignals } from "../types";
import { DETECTORS } from "./detectors";

export { DETECTED_CATALOG_ENTRY_IDS } from "./detectors";

/** Whether a catalog entry applies to a repository or could not be evaluated. */
type CatalogEntryStatus = "applies" | "clear" | "indeterminate";

/** One catalog entry evaluated against a repository's signals. */
interface CatalogFinding {
  entry: MigrationCatalogEntry;
  status: CatalogEntryStatus;
  /** Human-readable evidence, present only when `status === "applies"`. */
  evidence?: string;
}

/** Rolled-up counts for a repo profile. */
interface ProfileSummary {
  /** Catalog entries that apply (any severity). */
  applies: number;
  /** Applying entries with `severity === "blocker"`. */
  blockers: number;
  /** Applying entries with `severity === "warn"`. */
  warnings: number;
  /** Applying entries with `severity === "info"`. */
  infos: number;
  /** Catalog entries evaluated as not applying. */
  clear: number;
  /** Catalog entries whose signal is not gathered yet. */
  indeterminate: number;
}

/** A repository's full readiness profile. */
export interface RepoProfile {
  nameWithOwner: string;
  /** One finding per catalog entry, in catalog order. */
  findings: CatalogFinding[];
  summary: ProfileSummary;
}

/**
 * Catalog entry IDs evaluated at the organization level, not per repository — gathered
 * once per run by the org-resources REST pass (`run.orgResources`). They have no
 * per-repo detector, but they ARE evaluated, so the preparation summary counts
 * them as crawled (not “not yet evaluated”) and surfaces them via the org tiles.
 */
export const ORG_EVALUATED_CATALOG_ENTRY_IDS: readonly string[] = [
  "actions-secrets",
  "self-hosted-runners",
  "dependabot-secrets",
  "codespaces-secrets",
  "custom-properties",
  "teams",
  "github-apps",
];

function summarize(findings: CatalogFinding[]): ProfileSummary {
  const summary: ProfileSummary = {
    applies: 0,
    blockers: 0,
    warnings: 0,
    infos: 0,
    clear: 0,
    indeterminate: 0,
  };
  for (const { entry, status } of findings) {
    if (status === "clear") {
      summary.clear += 1;
    } else if (status === "indeterminate") {
      summary.indeterminate += 1;
    } else {
      summary.applies += 1;
      if (entry.severity === "blocker") summary.blockers += 1;
      else if (entry.severity === "warn") summary.warnings += 1;
      else summary.infos += 1;
    }
  }
  return summary;
}

/**
 * Analyze one repository's signals against the migration catalog.
 *
 * @returns A `RepoProfile` with one finding per catalog entry, in catalog order,
 *          and a rolled-up severity summary.
 */
export function analyzeRepo(signals: RepoSignals): RepoProfile {
  const findings: CatalogFinding[] = MIGRATION_CATALOG.map((entry) => {
    const detector = DETECTORS[entry.id];
    if (!detector) return { entry, status: "indeterminate" };
    const evidence = detector(signals);
    if (evidence === undefined) return { entry, status: "indeterminate" };
    return evidence != null
      ? { entry, status: "applies" as const, evidence }
      : { entry, status: "clear" as const };
  });

  return {
    nameWithOwner: signals.nameWithOwner,
    findings,
    summary: summarize(findings),
  };
}
