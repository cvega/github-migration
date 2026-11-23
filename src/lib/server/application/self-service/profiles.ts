import { MAX_PROFILE_PLAN_REPOS } from "$lib/profile/migration-plan";
import { listGrants, resolveGrant } from "$lib/server/application/self-service/grants";
import { getDb } from "$lib/server/core/db";
import { buildProfileDetailRollup } from "$lib/server/profile/analysis/rollup";
import { getScopedInventorySummary } from "$lib/server/profile/database/inventories";
import { repositoryNamespace } from "$lib/server/profile/database/namespace";
import { getRunRepoPlanProfiles, iterateRunRepoProfiles } from "$lib/server/profile/database/repos";
import { getRepositoryAnalysisDetail } from "$lib/server/profile/database/repository-analysis-runs";
import { getProfileRun, profileSearch } from "$lib/server/profile/database/runs";
import { getProfileRepoPage, type ProfileDetail } from "$lib/server/profile/service";
import type { ProfileRun } from "$lib/server/profile/types";

function eligibleRuns(userId: string, query: string) {
  const { sql, terms } = profileSearch(query);
  const routes = listGrants(userId).map((g) => [g.sourceProvider, g.sourceApiUrl, g.namespace]);
  return {
    from: `FROM profile_runs WHERE state = 'completed' AND completed_at IS NOT NULL
      AND (source_provider, source_api_url, org COLLATE BINARY) IN
        (SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?))${sql}`,
    params: [JSON.stringify(routes), ...terms],
  };
}

export function countOwnProfileRuns(userId: string, query = "") {
  const { from, params } = eligibleRuns(userId, query);
  return getDb()
    .query<{ n: number }, string[]>(`SELECT count(*) AS n ${from}`)
    .get(...params)!.n;
}

export function getScopedProfileStatus(run: ProfileRun) {
  const inventorySummary =
    run.sourceProvider === "github" ? null : getScopedInventorySummary(run.id, run.org);
  const scope = repositoryNamespace("name_with_owner", run.org);
  const counts =
    run.sourceProvider !== "github"
      ? { total: inventorySummary?.projectsCaptured ?? 0, blockers: 0, warnings: 0 }
      : getDb()
          .query<{ total: number; blockers: number; warnings: number }, Record<string, string>>(
            `SELECT count(*) AS total, coalesce(sum(blockers),0) AS blockers, coalesce(sum(warnings),0) AS warnings
       FROM profile_repos WHERE run_id=$id${scope.sql}`,
          )
          .get({ $id: run.id, ...scope.params })!;
  return {
    run: {
      ...run,
      totalRepos: counts.total,
      profiledRepos: counts.total,
      blockers: counts.blockers,
      warnings: counts.warnings,
      apiCalls: 0,
      failureReason: null,
    },
    inventorySummary,
  };
}

export function listOwnProfileRuns(userId: string, limit: number, offset: number, query = "") {
  const { from, params } = eligibleRuns(userId, query);
  return getDb()
    .query<{ id: string }, (string | number)[]>(
      `SELECT id ${from} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map(({ id }) => {
      const { run, inventorySummary } = getScopedProfileStatus(getProfileRun(id)!);
      return {
        ...run,
        inventoryProjectCount: inventorySummary?.projectCount ?? null,
        metrics: inventorySummary?.metrics,
      };
    });
}

export function resolveOwnProfile(userId: string, id: string) {
  const run = getProfileRun(id);
  if (run?.state !== "completed" || !run.completedAt) return null;
  const grant = resolveGrant(userId, run.sourceProvider, run.sourceApiUrl, run.org);
  return grant && { run, grant };
}

export function getOwnProfileDetail(
  run: ProfileRun,
  options: NonNullable<Parameters<typeof getProfileRepoPage>[1]> & { analysisRunId?: string },
): ProfileDetail {
  const repos = [...iterateRunRepoProfiles(run.id, run.org)];
  const rollup = buildProfileDetailRollup(repos);
  const analysis =
    run.sourceProvider === "github"
      ? getRepositoryAnalysisDetail(run.id, options.analysisRunId)
      : null;
  if (analysis) {
    const byName = new Map(repos.map((repo) => [repo.nameWithOwner, repo]));
    analysis.jobs = analysis.jobs.filter((job) => byName.has(job.nameWithOwner));
    const jobs = analysis.jobs;
    analysis.run = {
      ...analysis.run,
      selectedRepoCount: jobs.length,
      completedRepoCount: jobs.filter((job) => job.state === "succeeded").length,
      failedRepoCount: jobs.filter((job) => job.state === "failed").length,
      unknownSizeRepoCount: jobs.filter((job) => job.estimatedWorkspaceBytes === null).length,
      estimatedCloneBytes: jobs.reduce(
        (n, job) => n + (byName.get(job.nameWithOwner)?.signals.diskUsageKb ?? 0) * 1024,
        0,
      ),
      estimatedPeakWorkspaceBytes: jobs.reduce(
        (n, job) => Math.max(n, job.estimatedWorkspaceBytes ?? 0),
        0,
      ),
      failureReason: null,
    };
  }
  return {
    ...getScopedProfileStatus(run),
    ...getProfileRepoPage(run.id, { ...options, namespace: run.org })!,
    ...rollup,
    planningRepos: getRunRepoPlanProfiles(run.id, MAX_PROFILE_PLAN_REPOS, run.org),
    repositoryAnalysis: analysis,
  };
}
