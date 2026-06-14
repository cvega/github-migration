/**
 * Gap-analysis engine — runs a repository's signals against the GEI gap
 * registry and produces a per-repo readiness profile.
 *
 * The registry (`$lib/gap-registry`) is the canonical checklist of what GEI does
 * not migrate cleanly. This engine evaluates each entry against the gathered
 * `RepoSignals` and classifies it:
 *
 *   - applies        — the gap is present (with human-readable evidence)
 *   - clear          — evaluated and the gap does not apply
 *   - indeterminate  — the signal this gap needs hasn't been gathered yet
 *
 * Detectors are keyed by gap **id** (not the registry's `detector` string),
 * because one detector source can back several gaps — e.g. `git-sizer` underpins
 * both the commit-size and file-size limits. Only gaps whose signals the crawl
 * currently gathers have a detector; everything else is honestly reported as
 * indeterminate until a later crawl pass supplies its signal.
 */
import { GAP_REGISTRY, type GapEntry } from "$lib/gap-registry";
import type { RepoSignals } from "./types";

/** Whether a registry gap applies to a repo, or couldn't be evaluated. */
type GapStatus = "applies" | "clear" | "indeterminate";

/** One registry gap evaluated against a repo's signals. */
interface GapFinding {
  gap: GapEntry;
  status: GapStatus;
  /** Human-readable evidence, present only when `status === "applies"`. */
  evidence?: string;
}

/** Rolled-up counts for a repo profile. */
interface ProfileSummary {
  /** Gaps that apply (any severity). */
  applies: number;
  /** Applying gaps with `severity === "blocker"`. */
  blockers: number;
  /** Applying gaps with `severity === "warn"`. */
  warnings: number;
  /** Applying gaps with `severity === "info"`. */
  infos: number;
  /** Gaps evaluated as not applying. */
  clear: number;
  /** Gaps whose signal isn't gathered yet. */
  indeterminate: number;
}

/** A repository's full readiness profile. */
export interface RepoProfile {
  nameWithOwner: string;
  /** One finding per registry gap, in registry order. */
  findings: GapFinding[];
  summary: ProfileSummary;
}

/** A detector returns evidence when the gap applies, or null when it's clear. */
type Detector = (signals: RepoSignals) => string | null;

/** `n thing` / `n things` — small pluralization helper for evidence strings. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Detectors for the gaps the crawl can currently evaluate, keyed by gap id.
 * Add an entry here as each new signal is gathered by the crawl passes.
 */
const DETECTORS: Record<string, Detector> = {
  discussions: (s) => (s.discussionsCount > 0 ? count(s.discussionsCount, "discussion") : null),
  "projects-v2": (s) => (s.projectsV2Count > 0 ? count(s.projectsV2Count, "project") : null),
  "actions-environments": (s) =>
    s.environmentsCount > 0 ? count(s.environmentsCount, "environment") : null,
  "branch-protection-partial": (s) =>
    s.branchProtectionRulesUsingUnmigratedFeatures > 0
      ? `${count(s.branchProtectionRulesUsingUnmigratedFeatures, "rule")} using unmigrated features`
      : null,
  "stars-watchers": (s) =>
    s.stargazerCount > 0 || s.watcherCount > 0
      ? `${count(s.stargazerCount, "star")}, ${count(s.watcherCount, "watcher")}`
      : null,
  "fork-relationships": (s) => (s.isFork ? "repository is a fork" : null),
  "wiki-attachments": (s) => (s.hasWiki ? "wiki enabled (attachments not migrated)" : null),
};

/** Gap ids the engine can currently evaluate (the rest report indeterminate). */
export const DETECTED_GAP_IDS: readonly string[] = Object.keys(DETECTORS);

function summarize(findings: GapFinding[]): ProfileSummary {
  const summary: ProfileSummary = {
    applies: 0,
    blockers: 0,
    warnings: 0,
    infos: 0,
    clear: 0,
    indeterminate: 0,
  };
  for (const { gap, status } of findings) {
    if (status === "clear") {
      summary.clear += 1;
    } else if (status === "indeterminate") {
      summary.indeterminate += 1;
    } else {
      summary.applies += 1;
      if (gap.severity === "blocker") summary.blockers += 1;
      else if (gap.severity === "warn") summary.warnings += 1;
      else summary.infos += 1;
    }
  }
  return summary;
}

/**
 * Analyze one repository's signals against the gap registry.
 *
 * @returns A `RepoProfile` with one finding per registry gap (in registry
 *          order) and a rolled-up severity summary.
 */
export function analyzeRepo(signals: RepoSignals): RepoProfile {
  const findings: GapFinding[] = GAP_REGISTRY.map((gap) => {
    const detector = DETECTORS[gap.id];
    if (!detector) return { gap, status: "indeterminate" };
    const evidence = detector(signals);
    return evidence != null
      ? { gap, status: "applies" as const, evidence }
      : { gap, status: "clear" as const };
  });

  return {
    nameWithOwner: signals.nameWithOwner,
    findings,
    summary: summarize(findings),
  };
}
