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
 * Repos per augment request. Even though most of the query is cheap
 * `{ totalCount }` connections, each repo also does two server-side git-object
 * reads (`.gitattributes` blob + `.github/workflows` tree), and repos with
 * releases add the deeply-nested release-asset scan. In practice that pushes
 * wide batches past GitHub's 10s GraphQL execution timeout (a 502/504), so
 * batches are kept small: 10-15 repos per request. Repos discovery found to
 * have zero releases skip the release scan and use the upper bound (LITE);
 * repos with releases use the lower bound (FULL). If a chunk still times out,
 * `augmentRepoSignals` splits and retries it, so these are safe ceilings.
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

/**
 * Produce a concise, actionable failure reason from a crawl error. Octokit
 * surfaces HTTP failures with a numeric `status` (e.g. 502 on a GraphQL
 * timeout) and GraphQL errors with an `errors[]` array; pull those out so the
 * persisted `failureReason` (shown on the detail page) says something useful
 * rather than a bare "[object Object]".
 */
function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      status?: number;
      message?: string;
      errors?: Array<{ message?: string; type?: string }>;
    };
    const parts: string[] = [];
    if (typeof e.status === "number") parts.push(`HTTP ${e.status}`);
    const firstGqlError = Array.isArray(e.errors) ? e.errors[0] : undefined;
    if (firstGqlError?.message) parts.push(firstGqlError.message);
    else if (firstGqlError?.type) parts.push(firstGqlError.type);
    else if (e.message) parts.push(e.message);
    if (parts.length > 0) return parts.join(": ");
  }
  return err instanceof Error ? err.message : String(err);
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
  const startedMs = Date.now();
  createProfileRun({ id: input.id, sourceApiUrl: input.sourceApiUrl, org: input.org });
  console.log(`[profile] run ${input.id} started — org=${input.org}, source=${input.sourceApiUrl}`);

  try {
    // Set the run total as soon as the FIRST discovery page reports it (the org
    // total is known from page 1) and nudge any live watcher, so the detail page
    // shows movement during the otherwise-silent discovery phase instead of
    // sitting at 0/0.
    let totalSet = false;
    const discovery = await d.discover(gql, input.org, (p) => {
      if (!totalSet && p.total > 0) {
        totalSet = true;
        setProfileRunTotal(input.id, p.total);
        onProgress?.({ runId: input.id, profiled: 0, total: p.total, repo: "" });
      }
    });
    if (!totalSet) setProfileRunTotal(input.id, discovery.total);
    console.log(
      `[profile] run ${input.id} discovered ${discovery.total} repo(s) in ${Date.now() - startedMs}ms`,
    );

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
          console.error(
            `[profile] run ${input.id} augment chunk failed — ${task.repos.length} repo(s), scanReleases=${task.scanReleases}:`,
            err,
          );
          if (firstError === null) firstError = err;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(AUGMENT_CONCURRENCY, tasks.length) }, () => worker()),
    );
    if (firstError !== null) throw firstError;

    completeProfileRun(input.id);
    const completed = getProfileRun(input.id);
    console.log(
      `[profile] run ${input.id} completed — ${profiled} repo(s) profiled, ` +
        `${completed?.blockers ?? 0} blocker(s), ${completed?.warnings ?? 0} warning(s) ` +
        `in ${Date.now() - startedMs}ms`,
    );
  } catch (err) {
    const reason = describeError(err);
    console.error(
      `[profile] run ${input.id} failed after ${Date.now() - startedMs}ms — ${reason}`,
      err,
    );
    failProfileRun(input.id, reason);
  }

  const run = getProfileRun(input.id);
  if (!run) throw new Error(`Profile run '${input.id}' vanished after execution`);
  return run;
}
