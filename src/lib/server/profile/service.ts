import { MAX_PROFILE_PLAN_REPOS, type ProfilePlanRepo } from "$lib/profile/migration-plan";
import type { RepositoryAnalysisDetail } from "$lib/profile/repository-analysis";
import type { ProfileInventorySummary } from "$lib/profile/types";
import { getSourceClients } from "$lib/server/core/auth";
import { safeErrorReason } from "$lib/server/core/safe-error";
import type { SourceInventoryProgress } from "$lib/source/types";
import { getSourceProviderAdapter } from "$lib/source-provider";
import { deriveInsights, type Insight } from "./analysis/insights";
import { buildProfileDetailRollup, type ProfileDetailRollup } from "./analysis/rollup";
import { getOrgResources } from "./collection/org-resources";
import { getOrgRulesetCount } from "./collection/rulesets";
import {
  failProfileInventoryRun,
  getBitbucketLfsTracking,
  getProfileInventorySummary,
} from "./database/inventories";
import {
  getRunRepoPlanProfiles,
  getRunRepoProfilesPage,
  iterateRunRepoProfiles,
  type RepoReadinessFilter,
} from "./database/repos";
import { getRepositoryAnalysisDetail } from "./database/repository-analysis-runs";
import {
  createProfileRun,
  failProfileRun,
  getProfileRun,
  getProfileRunRollup,
  ProfileRunCapacityError,
  setProfileRunApiCalls,
} from "./database/runs";
import { publishProfileEvent } from "./events";
import type { InventoryProfileClient, InventoryProfileInput } from "./inventory-runner";
import { runProfile } from "./runner";
import type { ProfileRun, StoredRepoProfile } from "./types";

export interface ProfileServiceDeps {
  buildSourceClients: typeof getSourceClients;
  run: typeof runProfile;
  newId: () => string;
}
interface InventoryProfileServiceDeps<Client extends InventoryProfileClient> {
  buildSourceClient(): Client;
  run(
    client: Client,
    input: InventoryProfileInput,
    onProgress?: (progress: SourceInventoryProgress) => void,
  ): Promise<ProfileRun>;
  newId(): string;
}
export type GitLabProfileServiceDeps<Client extends InventoryProfileClient> =
  InventoryProfileServiceDeps<Client>;
export type BitbucketProfileServiceDeps<Client extends InventoryProfileClient> =
  InventoryProfileServiceDeps<Client>;
const DEFAULT_DEPS: ProfileServiceDeps = {
  buildSourceClients: getSourceClients,
  run: runProfile,
  newId: () => Bun.randomUUIDv7(),
};
interface ActiveProfile {
  controller: AbortController;
  settled: Promise<void>;
  getApiCalls(): number;
}
const activeProfiles = new Map<string, ActiveProfile>();
let stopping: Promise<boolean> | undefined;

export class GitLabProfileCapacityError extends Error {
  constructor() {
    super("A GitLab inventory profile is already running");
    this.name = "GitLabProfileCapacityError";
  }
}
export class BitbucketProfileCapacityError extends Error {
  constructor() {
    super("A Bitbucket Server inventory profile is already running");
    this.name = "BitbucketProfileCapacityError";
  }
}
function assertProfileAdmission(): void {
  if (stopping) throw new Error("Profile service is shutting down");
}

function executeProfile(
  id: string,
  controller: AbortController,
  getApiCalls: () => number,
  run: () => Promise<ProfileRun>,
  onCrash: () => void,
): void {
  const settled = Promise.resolve()
    .then(run)
    .then((result) => publishProfileEvent(id, { type: "done", state: result.state }))
    .catch(onCrash)
    .catch((error) => console.error("[profile] Could not settle run", safeErrorReason(error)))
    .finally(() => {
      activeProfiles.delete(id);
    });
  activeProfiles.set(id, { controller, getApiCalls, settled });
}

export function stopActiveProfileRuns(timeoutMs = 5000): Promise<boolean> {
  if (stopping) return stopping;
  const active = [...activeProfiles.values()];
  let timer: ReturnType<typeof setTimeout> | undefined;
  stopping = Promise.race([
    Promise.all(active.map((run) => run.settled)).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ])
    .then((drained) => {
      // Startup recovery will fail any unfinished rows and retain their dispatch counts.
      if (!drained) {
        for (const [id, run] of activeProfiles) setProfileRunApiCalls(id, run.getApiCalls());
      }
      return drained;
    })
    .finally(() => {
      clearTimeout(timer);
      stopping = undefined;
    });
  for (const run of active) run.controller.abort(new Error("Profile worker shut down"));
  return stopping;
}

function crash(id: string, message: string, inventoryCalls?: () => number): void {
  let run = getProfileRun(id);
  if (run?.state === "running") {
    if (inventoryCalls) failProfileInventoryRun(id, message, inventoryCalls());
    else failProfileRun(id, message);
    run = getProfileRun(id);
  }
  if (run && run.state !== "running") publishProfileEvent(id, { type: "done", state: run.state });
}

export function startOrgProfile(org: string, deps: ProfileServiceDeps = DEFAULT_DEPS): ProfileRun {
  assertProfileAdmission();
  const controller = new AbortController();
  const requests = new AbortController();
  const clients = deps.buildSourceClients(AbortSignal.any([controller.signal, requests.signal]));
  const id = deps.newId();
  const run = createProfileRun({
    id,
    sourceApiUrl: clients.sourceApiUrl,
    org,
    enforceCapacity: true,
  });
  executeProfile(
    id,
    controller,
    clients.getApiCalls,
    () =>
      deps.run(
        clients,
        {
          id,
          org,
          sourceApiUrl: clients.sourceApiUrl,
          runAlreadyCreated: true,
          signal: controller.signal,
          abortRequests: () => requests.abort(),
        },
        (progress) =>
          publishProfileEvent(id, {
            type: "progress",
            profiled: progress.profiled,
            total: progress.total,
            repo: progress.repo,
            phase: progress.phase,
          }),
        {
          getOrgRulesetCount: (target) => getOrgRulesetCount(clients.rest, target),
          getOrgResources: (target) => getOrgResources(clients.rest, target),
        },
      ),
    () => crash(id, "Organization profiling failed"),
  );
  return run;
}

export function startGitLabProfile<Client extends InventoryProfileClient>(
  namespace: string,
  deps: GitLabProfileServiceDeps<Client>,
): ProfileRun {
  assertProfileAdmission();
  const client = deps.buildSourceClient();
  const initial = client.getApiCalls();
  const id = deps.newId();
  let run: ProfileRun;
  try {
    run = createProfileRun({
      id,
      sourceProvider: "gitlab",
      sourceApiUrl: client.apiUrl,
      org: namespace,
      enforceCapacity: true,
    });
  } catch (error) {
    if (error instanceof ProfileRunCapacityError) throw new GitLabProfileCapacityError();
    throw error;
  }
  const controller = new AbortController();
  const getApiCalls = () => client.getApiCalls() - initial;
  executeProfile(
    id,
    controller,
    getApiCalls,
    () =>
      deps.run(
        client,
        { id, namespace, runAlreadyCreated: true, signal: controller.signal },
        (progress) => publishProfileEvent(id, { type: "inventory-progress", ...progress }),
      ),
    () => crash(id, "GitLab inventory profiling failed", getApiCalls),
  );
  return run;
}

export function startBitbucketServerProfile<Client extends InventoryProfileClient>(
  namespace: string,
  deps: BitbucketProfileServiceDeps<Client>,
): ProfileRun {
  assertProfileAdmission();
  const client = deps.buildSourceClient();
  const initial = client.getApiCalls();
  const id = deps.newId();
  let run: ProfileRun;
  try {
    run = createProfileRun({
      id,
      sourceProvider: "bitbucket-server",
      sourceApiUrl: client.apiUrl,
      org: namespace,
      enforceCapacity: true,
    });
  } catch (error) {
    if (error instanceof ProfileRunCapacityError) throw new BitbucketProfileCapacityError();
    throw error;
  }
  const controller = new AbortController();
  const getApiCalls = () => client.getApiCalls() - initial;
  executeProfile(
    id,
    controller,
    getApiCalls,
    () =>
      deps.run(
        client,
        { id, namespace, runAlreadyCreated: true, signal: controller.signal },
        (progress) => publishProfileEvent(id, { type: "inventory-progress", ...progress }),
      ),
    () => crash(id, "Bitbucket Server inventory profiling failed", getApiCalls),
  );
  return run;
}

interface RepoProfileView extends StoredRepoProfile {
  insights: Insight[];
}
type DetailMetrics = { [K in keyof ProfileDetailRollup]: ProfileDetailRollup[K] | null };
function inventorySummaryFor(run: ProfileRun): ProfileInventorySummary | null {
  if (getSourceProviderAdapter(run.sourceProvider).profileKind !== "source-inventory") return null;
  let summary: ProfileInventorySummary | null;
  try {
    summary = getProfileInventorySummary(run.id);
  } catch {
    // An unreadable stored summary is shown as unavailable rather than failing the page.
    summary = null;
  }
  return summary && run.sourceProvider === "bitbucket-server"
    ? { ...summary, lfsTracking: getBitbucketLfsTracking(run.id) }
    : summary;
}

export interface ProfileDetail extends DetailMetrics {
  run: ProfileRun;
  repos: RepoProfileView[];
  planningRepos: ProfilePlanRepo[];
  repoPage: { page: number; totalPages: number; total: number; limit: number };
  inventorySummary: ProfileInventorySummary | null;
  repositoryAnalysis: RepositoryAnalysisDetail | null;
}
export function getProfileStatus(
  id: string,
): { run: ProfileRun; inventorySummary: ProfileInventorySummary | null } | null {
  const run = getProfileRun(id);
  if (!run) return null;
  return {
    run,
    inventorySummary: inventorySummaryFor(run),
  };
}
export function getProfileRepoPage(
  id: string,
  options: {
    page?: number;
    search?: string;
    readiness?: RepoReadinessFilter;
    namespace?: string;
  } = {},
) {
  const run = getProfileRun(id);
  if (!run) return null;
  if (run.sourceProvider === "github" && run.state !== "completed")
    return { repos: [], repoPage: { page: 1, totalPages: 1, total: 0, limit: 25 } };
  const page = getRunRepoProfilesPage(id, options);
  return {
    repos: page.repos.map((repo) => ({ ...repo, insights: deriveInsights(repo.signals) })),
    repoPage: {
      page: page.page,
      totalPages: page.totalPages,
      total: page.total,
      limit: page.limit,
    },
  };
}
export function getProfileDetail(
  id: string,
  options: {
    page?: number;
    search?: string;
    readiness?: RepoReadinessFilter;
    analysisRunId?: string;
  } = {},
): ProfileDetail | null {
  const run = getProfileRun(id);
  if (!run) return null;
  const page = getProfileRepoPage(id, options);
  if (!page) return null;
  let rollup: ProfileDetailRollup | null = null;
  if (run.sourceProvider !== "github" || run.state === "completed") {
    rollup = getProfileRunRollup(id);
    if (!rollup && run.state === "running") {
      rollup = buildProfileDetailRollup(iterateRunRepoProfiles(id));
    }
  }
  return {
    run,
    ...page,
    ...(rollup ?? { scale: null, composition: null, summary: null, estimate: null }),
    inventorySummary: inventorySummaryFor(run),
    planningRepos:
      run.state === "completed" &&
      getSourceProviderAdapter(run.sourceProvider).capabilities.planning
        ? getRunRepoPlanProfiles(id, MAX_PROFILE_PLAN_REPOS)
        : [],
    repositoryAnalysis: getRepositoryAnalysisDetail(id, options.analysisRunId),
  };
}
