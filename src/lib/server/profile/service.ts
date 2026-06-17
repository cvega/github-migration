/**
 * Profile service — the boundary between the HTTP routes and the crawl engine.
 * Starts background profiling runs and assembles run detail for the UI, keeping
 * the route handlers thin.
 *
 * Dependencies (source-client builder, the runner, the id generator) are
 * injectable so the orchestration is testable against a real in-memory store
 * with no network.
 */
import { getSourceClients, isSourceAuthAvailable } from "$lib/server/core/auth";
import { getDb } from "$lib/server/core/db";
import type { GitHubClient } from "$lib/server/core/github";
import { clearPause, requestPause } from "./control";
import { runEnterpriseProfile } from "./enterprise-runner";
import { type DurationEstimate, estimateDuration } from "./estimate";
import { publishEnterpriseEvent, publishProfileEvent } from "./events";
import { deriveInsights, type Insight } from "./insights";
import { getOrgResources } from "./org-resources";
import { getOrgRulesetCount } from "./rulesets";
import { type ProfileClients, runProfile } from "./runner";
import { recoverInterruptedProfiles } from "./schema";
import {
  getEnterpriseChildRuns,
  getEnterpriseRun,
  getProfileRun,
  getRunRepoProfile,
  getRunRepoProfiles,
  getRunRepoSummaries,
  listRunningEnterpriseRuns,
  listStandaloneRunningProfileRuns,
  refreshEnterpriseRunAggregates,
} from "./store";
import { buildPreparationSummary, type PreparationSummary } from "./summary";
import type { EnterpriseRun, ProfileRun, StoredRepoProfile } from "./types";

/** Injectable service dependencies (defaults use the real implementations). */
export interface ProfileServiceDeps {
  buildSourceClients: typeof getSourceClients;
  run: typeof runProfile;
  runEnterprise: typeof runEnterpriseProfile;
  newId: () => string;
}

const DEFAULT_DEPS: ProfileServiceDeps = {
  buildSourceClients: getSourceClients,
  run: runProfile,
  runEnterprise: runEnterpriseProfile,
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
 * Run one org profile that publishes its own SSE (per-repo progress + a terminal
 * `done`) and gathers org-level resources over REST. Shared by the standalone
 * org path and the enterprise child path, so a child org's detail page is just
 * as live as a standalone run's. Resolves with the settled run.
 */
function runOrgWithSse(
  deps: ProfileServiceDeps,
  clients: ProfileClients,
  rest: GitHubClient,
  input: {
    id: string;
    org: string;
    sourceApiUrl: string;
    enterpriseRunId?: string;
    resume?: boolean;
  },
): Promise<ProfileRun> {
  return deps
    .run(
      clients,
      input,
      (p) =>
        publishProfileEvent(input.id, {
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
    .then((run) => {
      publishProfileEvent(input.id, { type: "done", state: run.state });
      return run;
    });
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

  runOrgWithSse(deps, { gql, rest, getApiCalls }, rest, { id, org, sourceApiUrl }).catch((err) => {
    // The runner already persists failures on the run; this guards against an
    // unexpected throw escaping the background promise.
    console.error(`[profile] run ${id} crashed:`, err);
    publishProfileEvent(id, { type: "done", state: "failed" });
  });

  const run = getProfileRun(id);
  if (!run) throw new Error("profile run was not created");
  return run;
}

/**
 * Start profiling an entire enterprise in the background: enumerate its orgs and
 * run one child org profile per org. The enterprise run is created synchronously
 * (so the returned run is immediately queryable), then the crawl proceeds
 * without blocking the request. Each child org publishes its own SSE, so any
 * org's detail page stays live; the enterprise run is the source of truth for
 * the aggregate roll-up.
 *
 * @throws when no source credentials are configured (the route maps this to a
 *         400 before the crawl starts).
 */
export function startEnterpriseProfile(
  enterpriseSlug: string,
  deps: ProfileServiceDeps = DEFAULT_DEPS,
): EnterpriseRun {
  const { gql, rest, sourceApiUrl, getApiCalls } = deps.buildSourceClients();
  const clients: ProfileClients = { gql, rest, getApiCalls };
  const id = deps.newId();

  deps
    .runEnterprise(
      clients,
      { id, enterpriseSlug, sourceApiUrl },
      (p) =>
        publishEnterpriseEvent(id, {
          type: "progress",
          phase: p.phase,
          totalOrgs: p.totalOrgs,
          profiledOrgs: p.profiledOrgs,
          org: p.org,
        }),
      {
        runOrg: (c, input) => runOrgWithSse(deps, c, rest, input),
      },
    )
    .then((run) => publishEnterpriseEvent(id, { type: "done", state: run.state }))
    .catch((err) => {
      // The enterprise runner persists failures on the run; this guards against
      // an unexpected throw escaping the background promise.
      console.error(`[profile] enterprise run ${id} crashed:`, err);
      publishEnterpriseEvent(id, { type: "done", state: "failed" });
    });

  const run = getEnterpriseRun(id);
  if (!run) throw new Error("enterprise run was not created");
  return run;
}

/**
 * Request that a running org profile pause at its next safe checkpoint.
 *
 * Cooperative: this only flags the request, so the returned run is still
 * `running` until the crawl observes it (between augment chunks/passes), persists
 * `state='paused'` with its progress intact, and publishes a terminal `done`.
 * A run that isn't running is returned unchanged (nothing to pause); returns null
 * if no such run exists.
 */
export function requestProfilePause(id: string): ProfileRun | null {
  const run = getProfileRun(id);
  if (!run) return null;
  if (run.state === "running") requestPause(id);
  return getProfileRun(id);
}

/**
 * Resume a paused or failed org profile run, re-dispatching its crawl in the
 * background. Reloads the run's recorded repos and reprocesses only the
 * unfinished ones (see {@link runProfile}'s resume path), republishing SSE so a
 * watching page goes live again. A child run (one belonging to an enterprise)
 * refreshes its parent's aggregates as it settles.
 *
 * Returns the run flipped back to `running` (the reset runs synchronously), the
 * unchanged run when it's already running/completed (nothing to resume), or null
 * when no such run exists.
 *
 * @throws when no source credentials are configured (the route maps this to 400).
 */
export function resumeProfileRun(
  id: string,
  deps: ProfileServiceDeps = DEFAULT_DEPS,
): ProfileRun | null {
  const run = getProfileRun(id);
  if (!run) return null;
  if (run.state === "running" || run.state === "completed") return run;

  // Drop any stale pause request so the freshly-resumed crawl doesn't immediately
  // re-pause, then re-dispatch with resume=true.
  clearPause(id);
  const { gql, rest, sourceApiUrl, getApiCalls } = deps.buildSourceClients();
  const enterpriseRunId = run.enterpriseRunId ?? undefined;
  runOrgWithSse(deps, { gql, rest, getApiCalls }, rest, {
    id,
    org: run.org,
    sourceApiUrl,
    enterpriseRunId,
    resume: true,
  })
    .then((settled) => {
      // A resumed child run must refresh its enterprise parent's roll-up.
      if (enterpriseRunId) refreshEnterpriseRunAggregates(enterpriseRunId);
      return settled;
    })
    .catch((err) => {
      console.error(`[profile] resume of run ${id} crashed:`, err);
      publishProfileEvent(id, { type: "done", state: "failed" });
    });
  return getProfileRun(id);
}

/**
 * Re-dispatch an enterprise run with `resume=true`, wiring its progress + a
 * terminal `done` onto the enterprise SSE bus and binding each child org to the
 * shared {@link runOrgWithSse}. Shared by the startup resume and the on-demand
 * {@link resumeEnterpriseRun}.
 */
function dispatchEnterpriseResume(
  deps: ProfileServiceDeps,
  clients: ProfileClients,
  rest: GitHubClient,
  sourceApiUrl: string,
  run: EnterpriseRun,
): void {
  deps
    .runEnterprise(
      clients,
      { id: run.id, enterpriseSlug: run.enterpriseSlug, sourceApiUrl, resume: true },
      (p) =>
        publishEnterpriseEvent(run.id, {
          type: "progress",
          phase: p.phase,
          totalOrgs: p.totalOrgs,
          profiledOrgs: p.profiledOrgs,
          org: p.org,
        }),
      { runOrg: (c, runInput) => runOrgWithSse(deps, c, rest, runInput) },
    )
    .then((settled) => publishEnterpriseEvent(run.id, { type: "done", state: settled.state }))
    .catch((err) => {
      console.error(`[profile] resume of enterprise run ${run.id} crashed:`, err);
      publishEnterpriseEvent(run.id, { type: "done", state: "failed" });
    });
}

/**
 * Request that a running enterprise profile pause: stop fanning out to new orgs,
 * and pause any in-flight child org crawls so they stop at their next checkpoint.
 *
 * Cooperative — the returned run is still `running` until the crawl observes the
 * request and settles as `paused`. A run that isn't running is returned
 * unchanged; null if no such run exists.
 */
export function requestEnterprisePause(id: string): EnterpriseRun | null {
  const run = getEnterpriseRun(id);
  if (!run) return null;
  if (run.state === "running") {
    requestPause(id);
    // Pause the in-flight children too so their crawls stop promptly; a settled
    // or already-paused child is left as-is.
    for (const child of getEnterpriseChildRuns(id)) {
      if (child.state === "running") requestPause(child.id);
    }
  }
  return getEnterpriseRun(id);
}

/**
 * Resume a paused or failed enterprise profile run. Re-enumerates the orgs, skips
 * children that already completed, resumes the paused/unfinished ones, and starts
 * any new orgs — republishing enterprise SSE so a watching page goes live.
 *
 * Returns the run flipped back to `running` (the reset runs synchronously), the
 * unchanged run when it's already running/completed (nothing to resume), or null
 * when no such run exists.
 *
 * @throws when no source credentials are configured (the route maps this to 400).
 */
export function resumeEnterpriseRun(
  id: string,
  deps: ProfileServiceDeps = DEFAULT_DEPS,
): EnterpriseRun | null {
  const run = getEnterpriseRun(id);
  if (!run) return null;
  if (run.state === "running" || run.state === "completed") return run;

  // Drop any stale pause requests (enterprise + children) so the resumed crawl
  // doesn't immediately re-pause.
  clearPause(id);
  for (const child of getEnterpriseChildRuns(id)) clearPause(child.id);

  const { gql, rest, sourceApiUrl, getApiCalls } = deps.buildSourceClients();
  dispatchEnterpriseResume(deps, { gql, rest, getApiCalls }, rest, sourceApiUrl, run);
  return getEnterpriseRun(id);
}

/**
 * Resume profiling runs interrupted by a restart. Called once at startup (the
 * store leaves interrupted runs `running`). Each resumed crawl reloads its
 * recorded data and reprocesses only the unfinished work, then republishes SSE
 * so a watching page goes live:
 *   - Standalone org runs resume directly.
 *   - Enterprise runs re-enumerate their orgs, skip orgs whose child already
 *     completed, resume the unfinished children, and start any new orgs.
 *
 * When no source credentials are configured the runs can't be resumed, so every
 * interrupted run is failed instead (freeing detail pages from polling forever).
 */
export function resumeInterruptedProfiles(
  deps: ProfileServiceDeps = DEFAULT_DEPS,
  sourceAuthAvailable: () => boolean = isSourceAuthAvailable,
): void {
  const orgRuns = listStandaloneRunningProfileRuns();
  const enterpriseRuns = listRunningEnterpriseRuns();
  if (orgRuns.length === 0 && enterpriseRuns.length === 0) return;

  if (!sourceAuthAvailable()) {
    recoverInterruptedProfiles(getDb());
    console.log("[profile] failed interrupted run(s) — no source credentials to resume");
    return;
  }

  const { gql, rest, sourceApiUrl, getApiCalls } = deps.buildSourceClients();
  const clients: ProfileClients = { gql, rest, getApiCalls };

  for (const r of orgRuns) {
    runOrgWithSse(deps, clients, rest, {
      id: r.id,
      org: r.org,
      sourceApiUrl,
      resume: true,
    }).catch((err) => {
      console.error(`[profile] resume of run ${r.id} crashed:`, err);
      publishProfileEvent(r.id, { type: "done", state: "failed" });
    });
  }

  for (const e of enterpriseRuns) {
    dispatchEnterpriseResume(deps, clients, rest, sourceApiUrl, e);
  }

  console.log(
    `[profile] resuming ${orgRuns.length} org run(s) + ${enterpriseRuns.length} enterprise run(s)`,
  );
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

/** Paginated profile detail: run + aggregates + a slice of repos (without signals). */
export interface PaginatedProfileDetail {
  run: ProfileRun;
  repos: StoredRepoProfile[];
  totalRepos: number;
  scale: MigrationScale;
  summary: PreparationSummary;
  estimate: DurationEstimate;
}

/**
 * Assemble a run, its aggregates (from all repos), and a paginated slice of repos.
 * Server-side only: loads all repos to compute aggregates, but only returns a page
 * to the client. Expanded rows fetch full signals on demand via getRepoDetail.
 */
export function getProfileDetailPaginated(
  id: string,
  limit: number = 25,
  offset: number = 0,
): PaginatedProfileDetail | null {
  const run = getProfileRun(id);
  if (!run) return null;

  // Load all repos to compute org-level aggregates (scale, summary, estimate).
  // We need the full signals for this, but we won't return them to the client.
  const allRepos = getRunRepoProfiles(id);
  const allReposWithInsights = allRepos.map((repo) => ({
    ...repo,
    insights: deriveInsights(repo.signals),
  }));

  // Return only a page of repos (with all their fields for the table),
  // plus the aggregates computed from all repos.
  const pagedRepos = getRunRepoSummaries(id, limit, offset);

  return {
    run,
    repos: pagedRepos,
    totalRepos: run.totalRepos,
    scale: computeScale(allReposWithInsights),
    summary: buildPreparationSummary(allReposWithInsights),
    estimate: estimateDuration(allReposWithInsights),
  };
}

/** Full detail for a single repo: used when drilling into a specific repository. */
export interface RepoDetail extends StoredRepoProfile {
  insights: Insight[];
}

/**
 * Load a single repo's full details including insights.
 * Used when the user clicks into a specific repo for detailed analysis.
 */
export function getRepoDetail(runId: string, nameWithOwner: string): RepoDetail | null {
  const repo = getRunRepoProfile(runId, nameWithOwner);
  if (!repo) return null;
  return {
    ...repo,
    insights: deriveInsights(repo.signals),
  };
}

/** An enterprise run plus its child org runs (for the enterprise detail page). */
export interface EnterpriseDetail {
  run: EnterpriseRun;
  orgs: ProfileRun[];
}

/** Assemble an enterprise run and its child org runs, or null if unknown. */
export function getEnterpriseDetail(id: string): EnterpriseDetail | null {
  const run = getEnterpriseRun(id);
  if (!run) return null;
  return { run, orgs: getEnterpriseChildRuns(id) };
}
