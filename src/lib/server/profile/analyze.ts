/**
 * Consideration-analysis engine — runs a repository's signals against the GEI
 * consideration registry and produces a per-repo readiness profile.
 *
 * The registry (`$lib/profile/consideration-registry`) is the canonical checklist of
 * what GEI does not migrate cleanly. This engine evaluates each entry against
 * the gathered `RepoSignals` and classifies it:
 *
 *   - applies        — the consideration is present (with human-readable evidence)
 *   - clear          — evaluated and the consideration does not apply
 *   - indeterminate  — the signal this consideration needs hasn't been gathered yet
 *
 * Detectors are keyed by consideration **id** (not the registry's `detector`
 * string), because one detector source can back several considerations — e.g.
 * `git-sizer` underpins both the commit-size and file-size limits. Only
 * considerations whose signals the crawl currently gathers have a detector;
 * everything else is honestly reported as indeterminate until a later crawl
 * pass supplies its signal.
 */
import { type Consideration, MIGRATION_CONSIDERATIONS } from "$lib/profile/consideration-registry";
import type { RepoSignals } from "./types";

/** Whether a registry consideration applies to a repo, or couldn't be evaluated. */
type ConsiderationStatus = "applies" | "clear" | "indeterminate";

/** One registry consideration evaluated against a repo's signals. */
interface ConsiderationFinding {
  consideration: Consideration;
  status: ConsiderationStatus;
  /** Human-readable evidence, present only when `status === "applies"`. */
  evidence?: string;
}

/** Rolled-up counts for a repo profile. */
interface ProfileSummary {
  /** Considerations that apply (any severity). */
  applies: number;
  /** Applying considerations with `severity === "blocker"`. */
  blockers: number;
  /** Applying considerations with `severity === "warn"`. */
  warnings: number;
  /** Applying considerations with `severity === "info"`. */
  infos: number;
  /** Considerations evaluated as not applying. */
  clear: number;
  /** Considerations whose signal isn't gathered yet. */
  indeterminate: number;
}

/** A repository's full readiness profile. */
export interface RepoProfile {
  nameWithOwner: string;
  /** One finding per registry consideration, in registry order. */
  findings: ConsiderationFinding[];
  summary: ProfileSummary;
}

/** A detector returns evidence when the consideration applies, or null otherwise. */
type Detector = (signals: RepoSignals) => string | null;

/** `n thing` / `n things` — small pluralization helper for evidence strings. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Smallest GHES Git-archive size limit (2 GiB, in KiB). `diskUsage` is the
 * uncompressed working size and only a proxy for the compressed archive — a repo
 * already over this uncompressed is a genuine candidate to exceed the limit, so
 * it's flagged (as an estimate) for git-sizer confirmation. Repos under it are
 * cleared rather than nagged.
 */
const GIT_ARCHIVE_PROXY_KB = 2 * 1024 * 1024;

/**
 * Detectors for the considerations the crawl can currently evaluate, keyed by
 * consideration id. Add an entry here as each new signal is gathered.
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
  "git-archive-size-limit": (s) => {
    if (s.diskUsageKb == null || s.diskUsageKb < GIT_ARCHIVE_PROXY_KB) return null;
    const gib = (s.diskUsageKb / (1024 * 1024)).toFixed(1);
    return `repository size ~${gib} GiB (estimate — confirm with git-sizer)`;
  },
};

/** Consideration ids the engine can evaluate (the rest report indeterminate). */
export const DETECTED_CONSIDERATION_IDS: readonly string[] = Object.keys(DETECTORS);

function summarize(findings: ConsiderationFinding[]): ProfileSummary {
  const summary: ProfileSummary = {
    applies: 0,
    blockers: 0,
    warnings: 0,
    infos: 0,
    clear: 0,
    indeterminate: 0,
  };
  for (const { consideration, status } of findings) {
    if (status === "clear") {
      summary.clear += 1;
    } else if (status === "indeterminate") {
      summary.indeterminate += 1;
    } else {
      summary.applies += 1;
      if (consideration.severity === "blocker") summary.blockers += 1;
      else if (consideration.severity === "warn") summary.warnings += 1;
      else summary.infos += 1;
    }
  }
  return summary;
}

/**
 * Analyze one repository's signals against the consideration registry.
 *
 * @returns A `RepoProfile` with one finding per registry consideration (in
 *          registry order) and a rolled-up severity summary.
 */
export function analyzeRepo(signals: RepoSignals): RepoProfile {
  const findings: ConsiderationFinding[] = MIGRATION_CONSIDERATIONS.map((consideration) => {
    const detector = DETECTORS[consideration.id];
    if (!detector) return { consideration, status: "indeterminate" };
    const evidence = detector(signals);
    return evidence != null
      ? { consideration, status: "applies" as const, evidence }
      : { consideration, status: "clear" as const };
  });

  return {
    nameWithOwner: signals.nameWithOwner,
    findings,
    summary: summarize(findings),
  };
}
