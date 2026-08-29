import type { RepoSignals } from "../types";

type InsightTone = "opportunity" | "caution" | "note";

export interface Insight {
  id: string;
  tone: InsightTone;
  label: string;
  detail: string;
}

export const STALE_MONTHS = 12;

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

function monthsSince(iso: string, nowMs: number): number {
  return Math.floor((nowMs - new Date(iso).getTime()) / MS_PER_MONTH);
}

export function deriveInsights(signals: RepoSignals, nowMs: number = Date.now()): Insight[] {
  if (signals.isEmpty) {
    return [
      {
        id: "empty-repo",
        tone: "note",
        label: "Empty repository",
        detail: "No content to migrate — consider skipping it.",
      },
    ];
  }

  if (signals.isArchived) {
    return [
      {
        id: "archived-move-now",
        tone: "opportunity",
        label: "Archived",
        detail: "Safe to migrate as-is — an archived repository won't change.",
      },
    ];
  }

  if (signals.pushedAt) {
    const months = monthsSince(signals.pushedAt, nowMs);
    if (months >= STALE_MONTHS) {
      return [
        {
          id: "stale-confirm",
          tone: "caution",
          label: "Stale",
          detail: `No activity in ${months} months — confirm it's still needed before migrating.`,
        },
      ];
    }
  }

  return [];
}
