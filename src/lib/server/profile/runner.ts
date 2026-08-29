import type { graphql } from "@octokit/graphql";
import type { GitHubClient } from "$lib/server/core/github";
import { getSourceProviderAdapter } from "$lib/source-provider";
import { analyzeRepo } from "./analysis/repos";
import { buildProfileDetailRollup } from "./analysis/rollup";
import { countRepoCommits } from "./collection/commits";
import { discoverOrgRepos } from "./collection/discovery";
import {
  augmentRepoCounts,
  augmentRepoDetails,
  baseSignals,
  gatherRepoRestSignals,
} from "./collection/signals";
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
  ZERO_ORG_RESOURCES,
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
  getOrgRulesetCount: (org: string) => Promise<number>;
  getOrgResources: (org: string) => Promise<OrgResources>;
}
const DEFAULT_DEPS: ProfileRunnerDeps = {
  discover: discoverOrgRepos,
  augmentCounts: augmentRepoCounts,
  augmentDetails: augmentRepoDetails,
  countCommits: countRepoCommits,
  gatherRestSignals: gatherRepoRestSignals,
  getOrgRulesetCount: async () => 0,
  getOrgResources: async () => ZERO_ORG_RESOURCES,
};
const LIMITS = {
  counts: 15,
  details: 10,
  detailsLite: 15,
  augmentWorkers: 3,
  restWorkers: 8,
  writes: 100,
} as const;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}
async function pool<T>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await operation(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Profile worker cancelled");
}
function describe(error: unknown): string {
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
function risk(signals: RepoSignals): number {
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

    const signalMap = new Map<string, RepoSignals>();
    const initial = discovery.repos.map((repo) => {
      const value = baseSignals(repo);
      signalMap.set(repo.nameWithOwner, value);
      return value;
    });
    for (const batch of chunks(records(initial), LIMITS.writes))
      recordRepoProfiles(input.id, batch);
    if (initial.length > 0) progress("counting", 0, discovery.total);

    let profiled = 0;
    const countBatches = chunks(
      [...discovery.repos].sort(
        (left, right) => (right.diskUsageKb ?? 0) - (left.diskUsageKb ?? 0),
      ),
      LIMITS.counts,
    );
    await pool(countBatches, LIMITS.augmentWorkers, async (batch) => {
      try {
        const values = await dependency.augmentCounts(clients.gql, batch);
        cancelled(input.signal);
        recordRepoProfiles(input.id, records(values));
        for (const value of values) {
          signalMap.set(value.nameWithOwner, value);
          profiled += 1;
          progress("counting", profiled, discovery.total, value.nameWithOwner);
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        console.error(`[profile] counts failed for ${batch.length} repositories`, error);
      }
    });

    const ordered = [...discovery.repos].sort(
      (left, right) =>
        risk(signalMap.get(right.nameWithOwner) ?? baseSignals(right)) -
        risk(signalMap.get(left.nameWithOwner) ?? baseSignals(left)),
    );
    const detailTasks = [
      ...chunks(
        ordered.filter((repo) => (signalMap.get(repo.nameWithOwner)?.releasesCount ?? 0) === 0),
        LIMITS.detailsLite,
      ).map((repos) => ({ repos, scanReleases: false })),
      ...chunks(
        ordered.filter((repo) => (signalMap.get(repo.nameWithOwner)?.releasesCount ?? 0) > 0),
        LIMITS.details,
      ).map((repos) => ({ repos, scanReleases: true })),
    ];
    if (detailTasks.length > 0) progress("details", profiled, discovery.total);
    await pool(detailTasks, LIMITS.augmentWorkers, async (task) => {
      try {
        const details = await dependency.augmentDetails(clients.gql, task.repos, {
          scanReleases: task.scanReleases,
        });
        cancelled(input.signal);
        const merged = details.flatMap((detail) => {
          const current = signalMap.get(detail.nameWithOwner);
          if (!current) return [];
          const value = { ...current, ...detail };
          signalMap.set(detail.nameWithOwner, value);
          return [value];
        });
        recordRepoProfiles(input.id, records(merged));
        progress("details", profiled, discovery.total);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        console.error(`[profile] details failed for ${task.repos.length} repositories`, error);
      }
    });

    if (ordered.length > 0) progress("signals", profiled, discovery.total);
    await pool(ordered, LIMITS.restWorkers, async (repo) => {
      const current = signalMap.get(repo.nameWithOwner);
      if (!current) return;
      try {
        const [commitsCount, rest] = await Promise.all([
          dependency.countCommits(clients.rest, repo),
          dependency.gatherRestSignals(clients.rest, repo),
        ]);
        cancelled(input.signal);
        const value = { ...current, commitsCount, ...rest };
        signalMap.set(repo.nameWithOwner, value);
        recordRepoProfiles(input.id, records([value]));
      } catch (error) {
        if (input.signal?.aborted) throw error;
        console.error(`[profile] REST signals failed for ${repo.nameWithOwner}`, error);
      }
    });
    if (ordered.length > 0) progress("signals", profiled, discovery.total);
    cancelled(input.signal);
    setProfileRunApiCalls(input.id, clients.getApiCalls());
    saveProfileRunRollup(input.id, buildProfileDetailRollup(iterateRunRepoProfiles(input.id)));
    completeProfileRun(input.id);
  } catch (error) {
    failProfileRun(input.id, describe(error));
  }
  const run = getProfileRun(input.id);
  if (!run) throw new Error(`Profile run '${input.id}' vanished after execution`);
  return run;
}
