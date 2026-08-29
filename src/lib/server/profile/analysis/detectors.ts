import type { RepoSignals } from "../types";

type Detector = (signals: RepoSignals) => string | null;

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

const GIT_ARCHIVE_PROXY_KB = 2 * 1024 * 1024;
const RELEASE_LIMIT_BYTES = 10 * 1024 ** 3;
const METADATA_LIMIT_BYTES = 40 * 1024 ** 3;

function toGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

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
      ? `${count(signals.branchProtectionRulesUsingUnmigratedFeatures, "rule")} using unmigrated features`
      : null,
  rulesets: (signals) => (signals.rulesetCount > 0 ? count(signals.rulesetCount, "ruleset") : null),
  "tag-protection": (signals) =>
    signals.tagProtectionCount > 0
      ? `${count(signals.tagProtectionCount, "tag protection rule")} (recreate as rulesets)`
      : null,
  webhooks: (signals) =>
    signals.webhooksCount > 0 ? count(signals.webhooksCount, "webhook") : null,
  "repo-collaborators": (signals) =>
    signals.collaboratorsCount > 0
      ? `${count(signals.collaboratorsCount, "direct collaborator")} (access not migrated)`
      : null,
  pages: (signals) =>
    signals.hasPages ? "GitHub Pages enabled (reconfigure on the target)" : null,
  "code-scanning-history": (signals) =>
    signals.hasCodeScanningAlerts
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
  "release-size-limit": (signals) =>
    signals.releaseAssetBytes >= RELEASE_LIMIT_BYTES
      ? `~${toGiB(signals.releaseAssetBytes)} GiB of release assets (limit 10 GiB — estimate)`
      : null,
  "metadata-archive-limit": (signals) =>
    signals.releaseAssetBytes >= METADATA_LIMIT_BYTES
      ? `~${toGiB(signals.releaseAssetBytes)} GiB of release assets (metadata limit 40 GiB — estimate)`
      : null,
};

export const DETECTED_CATALOG_ENTRY_IDS: readonly string[] = Object.keys(DETECTORS);
