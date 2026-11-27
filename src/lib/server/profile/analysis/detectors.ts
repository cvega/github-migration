import { releaseScanComplete, ruleScanComplete } from "$lib/profile/readiness";
import type { RepoSignals } from "../types";

// A null finding is clear; undefined means its evidence could not be read.
type Detector = (signals: RepoSignals) => string | null | undefined;

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

const GIT_ARCHIVE_PROXY_KB = 2 * 1024 * 1024;
const RELEASE_LIMIT_BYTES = 10 * 1024 ** 3;
const METADATA_LIMIT_BYTES = 40 * 1024 ** 3;

export const DETECTORS: Readonly<Record<string, Detector>> = {
  "git-lfs": (signals) =>
    signals.usesLfs
      ? "Git LFS in use (.gitattributes filter=lfs); objects pushed post-migration"
      : null,
  packages: (signals) =>
    signals.packagesCount > 0 ? count(signals.packagesCount, "package") : null,
  discussions: (signals) =>
    signals.discussionsCount > 0 ? count(signals.discussionsCount, "discussion") : null,
  "projects-v2": (signals) =>
    signals.projectsV2Count > 0 ? count(signals.projectsV2Count, "project") : null,
  "actions-environments": (signals) =>
    signals.environmentsCount > 0 ? count(signals.environmentsCount, "environment") : null,
  "branch-protection-partial": (signals) =>
    signals.branchProtectionRulesUsingUnmigratedFeatures > 0
      ? `${ruleScanComplete(signals) ? "" : "At least "}${count(signals.branchProtectionRulesUsingUnmigratedFeatures, "rule")} using unmigrated features`
      : ruleScanComplete(signals)
        ? null
        : undefined,
  rulesets: (signals) => (signals.rulesetCount > 0 ? count(signals.rulesetCount, "ruleset") : null),
  "tag-protection": (signals) =>
    signals.tagProtectionCount === null
      ? undefined
      : signals.tagProtectionCount > 0
        ? `${count(signals.tagProtectionCount, "tag protection rule")} (recreate as rulesets)`
        : null,
  webhooks: (signals) =>
    signals.webhooksCount === null
      ? undefined
      : signals.webhooksCount > 0
        ? count(signals.webhooksCount, "webhook")
        : null,
  "repo-collaborators": (signals) =>
    signals.collaboratorsCount === null
      ? undefined
      : signals.collaboratorsCount > 0
        ? `${count(signals.collaboratorsCount, "direct collaborator")} (access not migrated)`
        : null,
  pages: (signals) =>
    signals.hasPages ? "GitHub Pages enabled (reconfigure on the target)" : null,
  "code-scanning-history": (signals) =>
    signals.hasCodeScanningAlerts === null
      ? undefined
      : signals.hasCodeScanningAlerts
        ? "code scanning alerts present (history & states not migrated)"
        : null,
  "stars-watchers": (signals) =>
    signals.stargazerCount > 0 || signals.watcherCount > 0
      ? `${count(signals.stargazerCount, "star")}, ${count(signals.watcherCount, "watcher")}`
      : null,
  "fork-relationships": (signals) => (signals.isFork ? "repository is a fork" : null),
  "wiki-attachments": (signals) =>
    signals.hasWiki ? "wiki enabled (attachments not migrated)" : null,
  "actions-run-history": (signals) =>
    signals.workflowFileCount > 0
      ? `${count(signals.workflowFileCount, "workflow")} (run history & artifacts not migrated)`
      : null,
  "git-archive-size-limit": (signals) => {
    if (signals.diskUsageKb == null || signals.diskUsageKb < GIT_ARCHIVE_PROXY_KB) return null;
    const gib = (signals.diskUsageKb / (1024 * 1024)).toFixed(1);
    return `repository size ~${gib} GiB (estimate — confirm with git-sizer)`;
  },
  "release-size-limit": (signals) => releaseLimit(signals, RELEASE_LIMIT_BYTES, "limit 10 GiB"),
  "metadata-archive-limit": (signals) =>
    releaseLimit(signals, METADATA_LIMIT_BYTES, "metadata limit 40 GiB"),
};

function releaseLimit(signals: RepoSignals, threshold: number, label: string) {
  const complete = releaseScanComplete(signals);
  if (signals.releaseAssetBytes < threshold) return complete ? null : undefined;
  const gib = signals.releaseAssetBytes / 1024 ** 3;
  const observed = complete ? `~${gib.toFixed(1)}` : `At least ${Math.floor(gib)}`;
  return `${observed} GiB of release assets (${label} — estimate)`;
}

export const DETECTED_CATALOG_ENTRY_IDS: readonly string[] = Object.keys(DETECTORS);
