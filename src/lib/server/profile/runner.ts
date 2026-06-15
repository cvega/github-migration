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
  setProfileRunOrgResources,
  setProfileRunRulesets,
  setProfileRunTotal,
} from "./store";
import {
  type OrgResources,
  type ProfileProgress,
  type ProfileRun,
  ZERO_ORG_RESOURCES,
} from "./types";

/**
 * Repos per augment request. Each repo carries server-side git object reads
 * (`.gitattributes` blob + `.github/workflows` tree) plus up to 100
 * branch-protection nodes — and, for release-bearing repos, the release-asset
 * scan — so the real cost per repo is high and the limiting factor is GitHub's
 * ~10s GraphQL execution timeout, not the static node budget. These widths are
 * deliberately small: wide batches (e.g. 25+) time out and return a 502.
 *
 * LITE = repos discovery found to have zero releases (skip the release scan).
 * FULL = repos with releases (the heaviest queries), kept at the floor.
 */
const AUGMENT_CHUNK_FULL = 10;
const AUGMENT_CHUNK_LITE = 15;

/** How many augment requests are in flight at once (cuts wall-clock ~Nx). */
const AUGMENT_CONCURRENCY = 3;

/** Split an array into fixed-size chunks (the last may be smaller). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Injectable crawl primitives (defaults hit the real GraphQL helpers). */
export interface ProfileRunnerDeps {
  discover: typeof discoverOrgRepos;
  augment: typeof augmentRepoSignals;
  /** Count the org's rulesets. Default is a no-op (0); the service binds the
   *  real REST-backed implementation, which needs a client this module lacks. */
  getOrgRulesetCount: (org: string) => Promise<number>;
  /** Gather org-level resource counts. Default is zeros; the service binds the
   *  real REST-backed implementation. */
  getOrgResources: (org: string) => Promise<OrgResources>;
}

const DEFAULT_DEPS: ProfileRunnerDeps = {
  discover: discoverOrgRepos,
  augment: augmentRepoSignals,
  getOrgRulesetCount: async () => 0,
  getOrgResources: async () => ZERO_ORG_RESOURCES,
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
  deps: Partial<ProfileRunnerDeps> = {},
): Promise<ProfileRun> {
  const d = { ...DEFAULT_DEPS, ...deps };
  createProfileRun({ id: input.id, sourceApiUrl: input.sourceApiUrl, org: input.org });

  try {
    const discovery = await d.discover(gql, input.org);
    setProfileRunTotal(input.id, discovery.total);

    // Org-level signals are gathered once per run (best-effort, never fatal) —
    // they're org-scoped, not per-repo. Run the two REST passes concurrently.
    const [rulesetCount, orgResources] = await Promise.all([
      d.getOrgRulesetCount(input.org),
      d.getOrgResources(input.org),
    ]);
    setProfileRunRulesets(input.id, rulesetCount);
    setProfileRunOrgResources(input.id, orgResources);

    // Profile repos in chunks. Repos with no releases skip the release-asset
    // scan and batch wide; repos with releases batch narrow. Chunks run with
    // bounded concurrency to cut wall-clock without stressing rate limits.
    const withReleases = discovery.repos.filter((r) => r.releasesCount > 0);
    const withoutReleases = discovery.repos.filter((r) => r.releasesCount === 0);
    const tasks: Array<{ repos: typeof discovery.repos; scanReleases: boolean }> = [
      ...chunk(withoutReleases, AUGMENT_CHUNK_LITE).map((repos) => ({
        repos,
        scanReleases: false,
      })),
      ...chunk(withReleases, AUGMENT_CHUNK_FULL).map((repos) => ({ repos, scanReleases: true })),
    ];

    let profiled = 0;
    let firstError: unknown = null;
    let next = 0;
    // A worker pulls the next chunk until the queue drains or a chunk fails.
    // Completed chunks persist regardless; the first error fails the run after
    // in-flight chunks settle (mirrors the previous stop-on-first-failure).
    const worker = async (): Promise<void> => {
      while (next < tasks.length && firstError === null) {
        const task = tasks[next++];
        if (!task) break;
        try {
          const chunkSignals = await d.augment(gql, task.repos, {
            scanReleases: task.scanReleases,
          });
          for (const signals of chunkSignals) {
            recordRepoProfile(input.id, signals, analyzeRepo(signals));
            profiled += 1;
            onProgress?.({
              runId: input.id,
              profiled,
              total: discovery.total,
              repo: signals.nameWithOwner,
            });
          }
        } catch (err) {
          if (firstError === null) firstError = err;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(AUGMENT_CONCURRENCY, tasks.length) }, () => worker()),
    );
    if (firstError !== null) throw firstError;

    completeProfileRun(input.id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failProfileRun(input.id, reason);
  }

  const run = getProfileRun(input.id);
  if (!run) throw new Error(`Profile run '${input.id}' vanished after execution`);
  return run;
}
