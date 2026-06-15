/**
 * Migration preparation summary — the org-level rollup that turns per-repo
 * findings into a "what must we prepare" checklist.
 *
 * Where `analyze` answers "what won't migrate cleanly for THIS repo", this
 * answers "across the whole org, what supplemental tooling and reconfiguration
 * will the migration need, and how many repos does each touch". It also reports,
 * honestly, which registry considerations the crawl can't yet evaluate (their
 * signal isn't gathered), so coverage gaps aren't mistaken for clean results.
 *
 * Pure and derived-on-read from the persisted per-repo profiles — no schema and
 * no network — so it recomputes correctly however the run was recorded.
 */
import {
  type ConsiderationKind,
  type ConsiderationSeverity,
  MIGRATION_CONSIDERATIONS,
} from "$lib/profile/consideration-registry";
import { DETECTED_CONSIDERATION_IDS } from "./analyze";
import type { StoredRepoProfile } from "./types";

/** One consideration rolled up across the org, with how many repos it touches. */
interface PreparationItem {
  considerationId: string;
  label: string;
  kind: ConsiderationKind;
  severity: ConsiderationSeverity;
  /** The external tool / remediation this routes to, or null (accepted loss). */
  routesTo: string | null;
  /** How many repos in the run this consideration applies to. */
  affectedRepos: number;
}

/** A registry consideration the crawl can't yet evaluate (no signal gathered). */
interface UncrawledConsideration {
  considerationId: string;
  label: string;
  severity: ConsiderationSeverity;
}

/** Org-level preparation rollup across a run's repos. */
export interface PreparationSummary {
  /** Applying considerations, most-actionable first (blocker→warn→info, then reach). */
  items: PreparationItem[];
  /** Considerations not yet detectable (signal not gathered) — honesty about coverage. */
  notYetCrawled: UncrawledConsideration[];
  /** Repos with at least one blocker-severity consideration. */
  blockerRepos: number;
  /** Repos with at least one warn-severity consideration. */
  warnRepos: number;
  /** Repos with no blocker- or warn-severity considerations. */
  cleanRepos: number;
}

/** Display/sort order for severities (most urgent first). */
const SEVERITY_RANK: Record<ConsiderationSeverity, number> = { blocker: 0, warn: 1, info: 2 };

/**
 * Roll a run's per-repo profiles up into an org-level preparation summary.
 *
 * @param repos The run's persisted per-repo profiles.
 * @returns     Applying considerations with org-wide reach, the not-yet-crawled
 *              set, and repo-level blocker/warn/clean tallies.
 */
export function buildPreparationSummary(repos: StoredRepoProfile[]): PreparationSummary {
  const meta = new Map(MIGRATION_CONSIDERATIONS.map((c) => [c.id, c]));
  const affected = new Map<string, number>();
  let blockerRepos = 0;
  let warnRepos = 0;
  let cleanRepos = 0;

  for (const repo of repos) {
    if (repo.blockers > 0) blockerRepos += 1;
    if (repo.warnings > 0) warnRepos += 1;
    if (repo.blockers === 0 && repo.warnings === 0) cleanRepos += 1;
    for (const finding of repo.applyingConsiderations) {
      affected.set(finding.considerationId, (affected.get(finding.considerationId) ?? 0) + 1);
    }
  }

  const items: PreparationItem[] = [];
  for (const [id, affectedRepos] of affected) {
    const c = meta.get(id);
    // Skip a stale id from an older registry (defensive; keeps the rollup valid).
    if (!c) continue;
    items.push({
      considerationId: id,
      label: c.label,
      kind: c.kind,
      severity: c.severity,
      routesTo: c.routesTo,
      affectedRepos,
    });
  }
  items.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.affectedRepos - a.affectedRepos ||
      a.label.localeCompare(b.label),
  );

  const detected = new Set(DETECTED_CONSIDERATION_IDS);
  const notYetCrawled: UncrawledConsideration[] = MIGRATION_CONSIDERATIONS.filter(
    (c) => !detected.has(c.id),
  ).map((c) => ({ considerationId: c.id, label: c.label, severity: c.severity }));

  return { items, notYetCrawled, blockerRepos, warnRepos, cleanRepos };
}
