/**
 * Profile service — the boundary between the HTTP routes and the crawl engine.
 * Starts background profiling runs and assembles run detail for the UI, keeping
 * the route handlers thin.
 *
 * Dependencies (source-client builder, the runner, the id generator) are
 * injectable so the orchestration is testable against a real in-memory store
 * with no network.
 */
import { getSourceClients } from "$lib/server/core/auth";
import { type DurationEstimate, estimateDuration } from "./estimate";
import { publishProfileEvent } from "./events";
import { deriveInsights, type Insight } from "./insights";
import { getOrgResources } from "./org-resources";
import { getOrgRulesetCount } from "./rulesets";
import { runProfile } from "./runner";
import { getProfileRun, getRunRepoProfiles } from "./store";
import { buildPreparationSummary, type PreparationSummary } from "./summary";
import type { ProfileRun, StoredRepoProfile } from "./types";

/** Injectable service dependencies (defaults use the real implementations). */
export interface ProfileServiceDeps {
  buildSourceClients: typeof getSourceClients;
  run: typeof runProfile;
  newId: () => string;
}

const DEFAULT_DEPS: ProfileServiceDeps = {
  buildSourceClients: getSourceClients,
  run: runProfile,
  newId: () => Bun.randomUUIDv7(),
};

/** A persisted repo profile plus its derived, on-read insights. */
interface RepoProfileView extends StoredRepoProfile {
  insights: Insight[];
}

/**
 * Org-wide content-volume totals across a run's repos — the migration's scale.
 * Derived on read by summing the persisted per-repo signals (no schema change),
 * so it stays correct however many times a repo was re-recorded.
 */
interface MigrationScale {
  repos: number;
  issues: number;
  pullRequests: number;
  commits: number;
  branches: number;
  tags: number;
  releases: number;
  /** Sum of repo disk usage in KiB (null entries count as 0). */
  diskUsageKb: number;
}

/** A run plus its per-repo results (each enriched with insights) and scale. */
export interface ProfileDetail {
  run: ProfileRun;
  repos: RepoProfileView[];
  scale: MigrationScale;
  /** Org-level preparation checklist rolled up from the per-repo findings. */
  summary: PreparationSummary;
  /** Coarse size-band duration estimate (parallelism applied client-side). */
  estimate: DurationEstimate;
}

/** Sum the per-repo signals into the org-wide migration-scale rollup. */
function computeScale(repos: RepoProfileView[]): MigrationScale {
  const scale: MigrationScale = {
    repos: repos.length,
    issues: 0,
    pullRequests: 0,
    commits: 0,
    branches: 0,
    tags: 0,
    releases: 0,
    diskUsageKb: 0,
  };
  for (const { signals } of repos) {
    scale.issues += signals.issuesCount;
    scale.pullRequests += signals.pullRequestsCount;
    scale.commits += signals.commitsCount;
    scale.branches += signals.branchesCount;
    scale.tags += signals.tagsCount;
    scale.releases += signals.releasesCount;
    scale.diskUsageKb += signals.diskUsageKb ?? 0;
  }
  return scale;
}

/**
 * Start profiling an organization in the background.
 *
 * The run record is created synchronously (the runner creates it before its
 * first `await`), so the returned run is immediately queryable; the crawl then
 * proceeds without blocking the request. The persisted run is the source of
 * truth — failures are recorded on it (state=failed). As the crawl advances it
 * publishes live progress to the SSE bus, and a terminal `done` once it settles,
 * so a watching detail page updates without polling.
 *
 * @throws when no source credentials are configured (the route maps this to a
 *         400 before the crawl starts).
 */
export function startOrgProfile(org: string, deps: ProfileServiceDeps = DEFAULT_DEPS): ProfileRun {
  const { gql, rest, sourceApiUrl, getApiCalls } = deps.buildSourceClients();
  const id = deps.newId();

  deps
    .run(
      { gql, rest, getApiCalls },
      { id, org, sourceApiUrl },
      (p) =>
        publishProfileEvent(id, {
          type: "progress",
          profiled: p.profiled,
          total: p.total,
          repo: p.repo,
          phase: p.phase,
        }),
      {
        getOrgRulesetCount: (target) => getOrgRulesetCount(rest, target),
        getOrgResources: (target) => getOrgResources(rest, target),
      },
    )
    .then((run) => publishProfileEvent(id, { type: "done", state: run.state }))
    .catch((err) => {
      // The runner already persists failures on the run; this guards against an
      // unexpected throw escaping the background promise.
      console.error(`[profile] run ${id} crashed:`, err);
      publishProfileEvent(id, { type: "done", state: "failed" });
    });

  const run = getProfileRun(id);
  if (!run) throw new Error("profile run was not created");
  return run;
}

/** Assemble a run and its per-repo results, or null if the run is unknown. */
export function getProfileDetail(id: string): ProfileDetail | null {
  const run = getProfileRun(id);
  if (!run) return null;
  const repos = getRunRepoProfiles(id).map((repo) => ({
    ...repo,
    insights: deriveInsights(repo.signals),
  }));
  return {
    run,
    repos,
    scale: computeScale(repos),
    summary: buildPreparationSummary(repos),
    estimate: estimateDuration(repos),
  };
}
