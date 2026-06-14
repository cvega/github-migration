/**
 * Profile runner — the synchronous orchestrator that turns an organization into
 * a persisted readiness profile:
 *
 *   discover (bulk) → augment (per repo) → analyze (vs registry) → persist
 *
 * It owns the run lifecycle: it creates the run, records the org total, writes
 * each repo's analysis, and marks the run completed — or, if discovery fails,
 * marks it failed with the reason. It never throws for a profiling failure; the
 * persisted run (its `state` and `failureReason`) is the source of truth, so a
 * caller always gets a `ProfileRun` back.
 *
 * The crawl primitives (`discover`, `augment`) are injected with real defaults,
 * so the orchestration — ordering, total, per-repo persistence, progress, and
 * failure handling — is unit-testable against a real in-memory store without a
 * network.
 */
import type { graphql } from "@octokit/graphql";
import { analyzeRepo } from "./analyze";
import { augmentRepoSignals } from "./augment";
import { discoverOrgRepos } from "./discover";
import {
  completeProfileRun,
  createProfileRun,
  failProfileRun,
  getProfileRun,
  recordRepoProfile,
  setProfileRunTotal,
} from "./store";
import type { ProfileProgress, ProfileRun } from "./types";

/** Injectable crawl primitives (defaults hit the real GraphQL helpers). */
export interface ProfileRunnerDeps {
  discover: typeof discoverOrgRepos;
  augment: typeof augmentRepoSignals;
}

const DEFAULT_DEPS: ProfileRunnerDeps = {
  discover: discoverOrgRepos,
  augment: augmentRepoSignals,
};

/**
 * Profile one organization end to end and persist the result.
 *
 * @param gql        Injected GraphQL client for the source.
 * @param input      Run id, org login, and the source API URL being profiled.
 * @param onProgress Optional per-repo progress callback (drives SSE later).
 * @param deps       Injectable crawl primitives (defaults to the real ones).
 * @returns          The final persisted run — `completed` or `failed`.
 */
export async function runProfile(
  gql: typeof graphql,
  input: { id: string; org: string; sourceApiUrl: string },
  onProgress?: (progress: ProfileProgress) => void,
  deps: ProfileRunnerDeps = DEFAULT_DEPS,
): Promise<ProfileRun> {
  createProfileRun({ id: input.id, sourceApiUrl: input.sourceApiUrl, org: input.org });

  try {
    const discovery = await deps.discover(gql, input.org);
    setProfileRunTotal(input.id, discovery.total);

    let profiled = 0;
    for (const repo of discovery.repos) {
      const signals = await deps.augment(gql, repo);
      recordRepoProfile(input.id, signals, analyzeRepo(signals));
      profiled += 1;
      onProgress?.({
        runId: input.id,
        profiled,
        total: discovery.total,
        repo: repo.nameWithOwner,
      });
    }

    completeProfileRun(input.id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failProfileRun(input.id, reason);
  }

  const run = getProfileRun(input.id);
  if (!run) throw new Error(`Profile run '${input.id}' vanished after execution`);
  return run;
}
