/**
 * Insights engine — higher-level, per-repo recommendations derived purely from
 * signals the crawl already gathered. Where the consideration analysis answers
 * "what won't migrate cleanly?", insights answer "what should I *do* about this
 * repo?" — surface a quick win, raise a caution, or note something minor.
 *
 * Pure and synchronous: no new API calls, no persistence. Computed on read from
 * a repo's `RepoSignals`, so it stays cheap and fully unit-testable.
 */
import type { RepoSignals } from "./types";

/** How an insight should read: a win to take, a caution to weigh, or a note. */
type InsightTone = "opportunity" | "caution" | "note";

/** One actionable recommendation about a repository. */
export interface Insight {
  /** Stable kebab-case identifier. */
  id: string;
  tone: InsightTone;
  /** Short headline for the UI. */
  label: string;
  /** One-line explanation / recommended action. */
  detail: string;
}

/** A repository is "stale" once it has had no push for this many months. */
export const STALE_MONTHS = 12;

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

/** Whole months between an ISO timestamp and now (floored, never negative). */
function monthsSince(iso: string, nowMs: number): number {
  const elapsed = nowMs - new Date(iso).getTime();
  return elapsed <= 0 ? 0 : Math.floor(elapsed / MS_PER_MONTH);
}

/**
 * Derive the insights that apply to one repository.
 *
 * @param signals  The repo's gathered signals.
 * @param nowMs    Clock injection point for deterministic staleness in tests.
 * @returns        Applicable insights (possibly empty), in display order.
 */
export function deriveInsights(signals: RepoSignals, nowMs: number = Date.now()): Insight[] {
  const insights: Insight[] = [];

  // Empty: little or nothing to migrate — note it and stop (staleness/archive
  // are redundant detail for an empty repo).
  if (signals.isEmpty) {
    insights.push({
      id: "empty-repo",
      tone: "note",
      label: "Empty repository",
      detail: "No content to migrate — consider skipping it.",
    });
    return insights;
  }

  // Archived: safe to move as-is, it won't change again. (Archived implies
  // inactive, so suppress the stale caution — it would be redundant noise.)
  if (signals.isArchived) {
    insights.push({
      id: "archived-move-now",
      tone: "opportunity",
      label: "Archived",
      detail: "Safe to migrate as-is — an archived repository won't change.",
    });
  } else if (signals.pushedAt) {
    const months = monthsSince(signals.pushedAt, nowMs);
    if (months >= STALE_MONTHS) {
      insights.push({
        id: "stale-confirm",
        tone: "caution",
        label: "Stale",
        detail: `No activity in ${months} months — confirm it's still needed before migrating.`,
      });
    }
  }

  return insights;
}
