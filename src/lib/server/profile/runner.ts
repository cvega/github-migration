import type { graphql } from "@octokit/graphql";
import type { GitHubClient } from "$lib/server/core/github";
import { getSourceProviderAdapter } from "$lib/source-provider";
import { analyzeRepo } from "./analysis/repos";
import { buildProfileDetailRollup } from "./analysis/rollup";
import { countRepoCommits } from "./collection/commits";
import { discoverOrgRepos } from "./collection/discovery";
import { augmentRepoCounts, augmentRepoDetails, gatherRepoRestSignals } from "./collection/signals";
import { iterateRunRepoProfiles, recordRepoProfiles } from "./database/repos";
import {
  completeProfileRun,
  createProfileRun,
  failProfileRun,
  getProfileRun,
  saveProfileRunRollup,
  setProfileRunApiCalls,
  setProfileRunOrgResources,
  setProfileRunRulesets,
  setProfileRunTotal,
} from "./database/runs";
import {
  type OrgResources,
  type ProfileProgress,
  type ProfileRun,
  type RepoSignals,
  UNKNOWN_ORG_RESOURCES,
} from "./types";

export interface ProfileClients {
  gql: typeof graphql;
  rest: GitHubClient;
  getApiCalls: () => number;
}
export interface ProfileRunnerDeps {
  discover: typeof discoverOrgRepos;
  augmentCounts: typeof augmentRepoCounts;
  augmentDetails: typeof augmentRepoDetails;
  countCommits: typeof countRepoCommits;
  gatherRestSignals: typeof gatherRepoRestSignals;
  getOrgRulesetCount: (org: string) => Promise<number | null>;
  getOrgResources: (org: string) => Promise<OrgResources>;
}
const DEFAULT_DEPS: ProfileRunnerDeps = {
  discover: discoverOrgRepos,
  augmentCounts: augmentRepoCounts,
  augmentDetails: augmentRepoDetails,
  countCommits: countRepoCommits,
  gatherRestSignals: gatherRepoRestSignals,
  getOrgRulesetCount: async () => null,
  getOrgResources: async () => UNKNOWN_ORG_RESOURCES,
};
const LIMITS = {
  counts: 15,
  details: 10,
  detailsLite: 15,
  augmentWorkers: 3,
  restWorkers: 8,
} as const;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}
async function pool<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const result: R[] = [];
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        result[index] = await operation(items[index] as T);
      } catch (error) {
        next = items.length;
        throw error;
      }
    }
  };
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  return result;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Profile worker cancelled");
}
function describeProfileError(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as {
      status?: number;
      message?: string;
      errors?: Array<{ message?: string; type?: string }>;
    };
    const detail = value.errors?.[0]?.message ?? value.errors?.[0]?.type ?? value.message;
    if (value.status && detail) return `HTTP ${value.status}: ${detail}`;
    if (value.status) return `HTTP ${value.status}`;
    if (detail) return detail;
  }
  return error instanceof Error ? error.message : String(error);
}
function risk(
  signals: Pick<RepoSignals, "issuesCount" | "pullRequestsCount" | "diskUsageKb" | "releasesCount">,
): number {
  return (
    signals.issuesCount +
    signals.pullRequestsCount +
    (signals.diskUsageKb ?? 0) / 1024 +
    signals.releasesCount * 10
  );
}
function records(signals: RepoSignals[]) {
  return signals.map((value) => ({ signals: value, profile: analyzeRepo(value) }));
}

export async function runProfile(
  clients: ProfileClients,
  input: {
    id: string;
    org: string;
    sourceApiUrl: string;
    runAlreadyCreated?: boolean;
    signal?: AbortSignal;
  },
  onProgress?: (progress: ProfileProgress) => void,
  deps: Partial<ProfileRunnerDeps> = {},
): Promise<ProfileRun> {
  const dependency = { ...DEFAULT_DEPS, ...deps };
  if (!input.runAlreadyCreated)
    createProfileRun({ id: input.id, sourceApiUrl: input.sourceApiUrl, org: input.org });
  const progress = (phase: ProfileProgress["phase"], profiled: number, total: number, repo = "") =>
    onProgress?.({ runId: input.id, phase, profiled, total, repo });
  try {
    cancelled(input.signal);
    const discovery = await dependency.discover(
      clients.rest,
      input.org,
      (value) => {
        cancelled(input.signal);
        setProfileRunTotal(input.id, value.total);
        progress("discovering", 0, value.total);
      },
      getSourceProviderAdapter("github").inventoryProjectLimit ?? 10_000,
    );
    cancelled(input.signal);
    setProfileRunTotal(input.id, discovery.total);
    progress("organization", 0, discovery.total);
    const [rulesets, resources] = await Promise.all([
      dependency.getOrgRulesetCount(input.org),
      dependency.getOrgResources(input.org),
    ]);
    setProfileRunRulesets(input.id, rulesets);
    setProfileRunOrgResources(input.id, resources);

    if (discovery.total > 0) progress("counting", 0, discovery.total);

    let profiled = 0;
    const countBatches = chunks(
      [...discovery.repos].sort(
        (left, right) => (right.diskUsageKb ?? 0) - (left.diskUsageKb ?? 0),
      ),
      LIMITS.counts,
    );
    const counts = await pool(countBatches, LIMITS.augmentWorkers, async (batch) => {
      cancelled(input.signal);
      const values = await dependency.augmentCounts(clients.gql, batch);
      progress("counting", 0, discovery.total, batch[0]?.nameWithOwner);
      return values;
    });

    const ordered = counts.flat().sort((left, right) => risk(right) - risk(left));
    const detailTasks = [
      ...chunks(
        ordered.filter((repo) => repo.releasesCount === 0),
        LIMITS.detailsLite,
      ).map((repos) => ({ repos, scanReleases: false })),
      ...chunks(
        ordered.filter((repo) => repo.releasesCount > 0),
        LIMITS.details,
      ).map((repos) => ({ repos, scanReleases: true })),
    ];
    if (detailTasks.length > 0) progress("details", profiled, discovery.total);
    const details = await pool(detailTasks, LIMITS.augmentWorkers, async (task) => {
      cancelled(input.signal);
      return dependency.augmentDetails(clients.gql, task.repos, {
        scanReleases: task.scanReleases,
      });
    });
    const byName = new Map(details.flat().map((detail) => [detail.nameWithOwner, detail]));

    if (ordered.length > 0) progress("signals", profiled, discovery.total);
    const signals = await pool(ordered, LIMITS.restWorkers, async (repo) => {
      cancelled(input.signal);
      const detail = byName.get(repo.nameWithOwner);
      if (!detail) throw new Error(`Missing GraphQL details for ${repo.nameWithOwner}`);
      try {
        const [commitsCount, rest] = await Promise.all([
          dependency.countCommits(clients.rest, repo),
          dependency.gatherRestSignals(clients.rest, repo),
        ]);
        cancelled(input.signal);
        progress("signals", ++profiled, discovery.total, repo.nameWithOwner);
        return {
          ...repo,
          ...detail,
          releaseAssetScanComplete: repo.releasesCount === 0 || detail.releaseAssetScanComplete,
          commitsCount,
          ...rest,
        };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        throw new Error(
          `REST signals unavailable for ${repo.nameWithOwner}: ${describeProfileError(error)}`,
        );
      }
    });
    cancelled(input.signal);
    if (signals.length !== discovery.total) throw new Error("Incomplete GitHub repository profile");
    recordRepoProfiles(input.id, records(signals));
    setProfileRunApiCalls(input.id, clients.getApiCalls());
    saveProfileRunRollup(input.id, buildProfileDetailRollup(iterateRunRepoProfiles(input.id)));
    completeProfileRun(input.id);
  } catch (error) {
    setProfileRunApiCalls(input.id, clients.getApiCalls());
    failProfileRun(input.id, describeProfileError(error));
  }
  const run = getProfileRun(input.id);
  if (!run) throw new Error(`Profile run '${input.id}' vanished after execution`);
  return run;
}
