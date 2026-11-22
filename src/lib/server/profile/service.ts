import { MAX_PROFILE_PLAN_REPOS, type ProfilePlanRepo } from "$lib/profile/migration-plan";
import type { RepositoryAnalysisDetail } from "$lib/profile/repository-analysis";
import { getSourceClients } from "$lib/server/core/auth";
import type { SourceInventoryProgress } from "$lib/source/types";
import { getSourceProviderAdapter } from "$lib/source-provider";
import { deriveInsights, type Insight } from "./analysis/insights";
import type { ProfileInventorySummary } from "./analysis/overview";
import { buildProfileDetailRollup, type ProfileDetailRollup } from "./analysis/rollup";
import { getOrgResources } from "./collection/org-resources";
import { getOrgRulesetCount } from "./collection/rulesets";
import { failProfileInventoryRun, getProfileInventorySummary } from "./database/inventories";
import {
  getRunRepoPlanProfiles,
  getRunRepoProfilesPage,
  iterateRunRepoProfiles,
  type RepoReadinessFilter,
} from "./database/repos";
import { getRepositoryAnalysisDetail } from "./database/repository-analysis-runs";
import {
  backfillProfileRunRollup,
  createProfileRun,
  failProfileRun,
  getProfileRun,
  getProfileRunRollup,
  ProfileRunCapacityError,
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
const controllers = new Map<string, AbortController>();

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
function execution(id: string): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  controllers.set(id, controller);
  return { signal: controller.signal, stop: () => controllers.delete(id) };
}
export function stopActiveProfileRuns(): void {
  for (const controller of controllers.values())
    controller.abort(new Error("Profile worker shut down"));
  controllers.clear();
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
  const clients = deps.buildSourceClients();
  const id = deps.newId();
  const run = createProfileRun({
    id,
    sourceApiUrl: clients.sourceApiUrl,
    org,
    enforceCapacity: true,
  });
  const active = execution(id);
  deps
    .run(
      clients,
      {
        id,
        org,
        sourceApiUrl: clients.sourceApiUrl,
        runAlreadyCreated: true,
        signal: active.signal,
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
    )
    .then((settled) => publishProfileEvent(id, { type: "done", state: settled.state }))
    .catch(() => crash(id, "Organization profiling failed"))
    .finally(active.stop);
  return run;
}

export function startGitLabProfile<Client extends InventoryProfileClient>(
  namespace: string,
  deps: GitLabProfileServiceDeps<Client>,
): ProfileRun {
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
  const active = execution(id);
  deps
    .run(client, { id, namespace, runAlreadyCreated: true, signal: active.signal }, (progress) =>
      publishProfileEvent(id, { type: "inventory-progress", ...progress }),
    )
    .then((settled) => publishProfileEvent(id, { type: "done", state: settled.state }))
    .catch(() =>
      crash(id, "GitLab inventory profiling failed", () => client.getApiCalls() - initial),
    )
    .finally(active.stop);
  return run;
}

export function startBitbucketServerProfile<Client extends InventoryProfileClient>(
  namespace: string,
  deps: BitbucketProfileServiceDeps<Client>,
): ProfileRun {
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
  const active = execution(id);
  deps
    .run(client, { id, namespace, runAlreadyCreated: true, signal: active.signal }, (progress) =>
      publishProfileEvent(id, { type: "inventory-progress", ...progress }),
    )
    .then((settled) => publishProfileEvent(id, { type: "done", state: settled.state }))
    .catch(() =>
      crash(
        id,
        "Bitbucket Server inventory profiling failed",
        () => client.getApiCalls() - initial,
      ),
    )
    .finally(active.stop);
  return run;
}

interface RepoProfileView extends StoredRepoProfile {
  insights: Insight[];
}
type DetailMetrics = { [K in keyof ProfileDetailRollup]: ProfileDetailRollup[K] | null };
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
    inventorySummary:
      getSourceProviderAdapter(run.sourceProvider).profileKind === "source-inventory"
        ? getProfileInventorySummary(id)
        : null,
  };
}
export function getProfileRepoPage(
  id: string,
  options: { page?: number; search?: string; readiness?: RepoReadinessFilter } = {},
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
    if (!rollup) {
      rollup = buildProfileDetailRollup(iterateRunRepoProfiles(id));
      if (run.state === "completed") backfillProfileRunRollup(id, rollup);
    }
  }
  return {
    run,
    ...page,
    ...(rollup ?? { scale: null, composition: null, summary: null, estimate: null }),
    inventorySummary:
      getSourceProviderAdapter(run.sourceProvider).profileKind === "source-inventory"
        ? getProfileInventorySummary(id)
        : null,
    planningRepos:
      run.state === "completed" &&
      getSourceProviderAdapter(run.sourceProvider).capabilities.planning
        ? getRunRepoPlanProfiles(id, MAX_PROFILE_PLAN_REPOS)
        : [],
    repositoryAnalysis: getRepositoryAnalysisDetail(id, options.analysisRunId),
  };
}
