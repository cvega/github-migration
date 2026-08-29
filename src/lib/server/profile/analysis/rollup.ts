import type { StoredRepoProfile } from "../types";
import { type DurationEstimate, estimateDuration } from "./duration";
import { deriveInsights } from "./insights";
import { buildPreparationSummary, type PreparationSummary } from "./plan";

interface MigrationScale {
  repos: number;
  issues: number;
  pullRequests: number;
  commits: number;
  branches: number;
  tags: number;
  releases: number;
  diskUsageKb: number;
}

interface RepositoryComposition {
  total: number;
  active: { count: number; pct: number };
  stale: { count: number; pct: number };
  empty: { count: number; pct: number };
  archived: { count: number; pct: number };
}

export interface ProfileDetailRollup {
  scale: MigrationScale;
  composition: RepositoryComposition;
  summary: PreparationSummary;
  estimate: DurationEstimate;
}

export function buildProfileDetailRollup(
  profiles: Iterable<StoredRepoProfile>,
): ProfileDetailRollup {
  const repos = [...profiles];
  const scale: MigrationScale = {
    repos: 0,
    issues: 0,
    pullRequests: 0,
    commits: 0,
    branches: 0,
    tags: 0,
    releases: 0,
    diskUsageKb: 0,
  };
  let empty = 0;
  let archived = 0;
  let stale = 0;

  for (const repo of repos) {
    const { signals } = repo;
    scale.repos += 1;
    scale.issues += signals.issuesCount;
    scale.pullRequests += signals.pullRequestsCount;
    scale.commits += signals.commitsCount;
    scale.branches += signals.branchesCount;
    scale.tags += signals.tagsCount;
    scale.releases += signals.releasesCount;
    scale.diskUsageKb += signals.diskUsageKb ?? 0;
    const insightIds = new Set(deriveInsights(signals).map((insight) => insight.id));
    if (insightIds.has("empty-repo")) empty += 1;
    else if (insightIds.has("archived-move-now")) archived += 1;
    else if (insightIds.has("stale-confirm")) stale += 1;
  }

  const active = Math.max(0, scale.repos - empty - archived - stale);
  const withPercent = (count: number) => ({
    count,
    pct: scale.repos > 0 ? Math.round((count / scale.repos) * 100) : 0,
  });

  return {
    scale,
    composition: {
      total: scale.repos,
      active: withPercent(active),
      stale: withPercent(stale),
      empty: withPercent(empty),
      archived: withPercent(archived),
    },
    summary: buildPreparationSummary(repos),
    estimate: estimateDuration(repos),
  };
}
