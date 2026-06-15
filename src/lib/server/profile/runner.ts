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
import { augmentRepoCounts, augmentRepoDetails } from "./augment";
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
  type RepoSignals,
  ZERO_ORG_RESOURCES,
} from "./types";

/**
 * Repos per augment request. The crawl runs in two passes:
 *   - COUNTS: cheap `{ totalCount }`/scalar fields only — fills each repo's
 *     counts fast and is very unlikely to hit GitHub's 10s timeout.
 *   - DETAILS: the expensive verification (commit-graph walk, two git-object
 *     reads, branch-protection detail, and — for release-bearing repos — the
 *     release-asset scan), so those batch smaller.
 * Kept at 10-15 repos/request; `augmentRepo*` further splits any chunk that
 * still times out, so these are safe ceilings.
 */
const COUNTS_CHUNK = 15;
const DETAILS_CHUNK_FULL = 10;
const DETAILS_CHUNK_LITE = 15;

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
  /** Pass 1: cheap per-repo counts. */
  augmentCounts: typeof augmentRepoCounts;
  /** Pass 2: expensive per-repo verification details. */
  augmentDetails: typeof augmentRepoDetails;
  /** Count the org's rulesets. Default is a no-op (0); the service binds the
   *  real REST-backed implementation, which needs a client this module lacks. */
  getOrgRulesetCount: (org: string) => Promise<number>;
  /** Gather org-level resource counts. Default is zeros; the service binds the
   *  real REST-backed implementation. */
  getOrgResources: (org: string) => Promise<OrgResources>;
}

const DEFAULT_DEPS: ProfileRunnerDeps = {
  discover: discoverOrgRepos,
  augmentCounts: augmentRepoCounts,
  augmentDetails: augmentRepoDetails,
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

    // ── Pass 1: cheap counts ──────────────────────────────────────────────
    // One aliased request per chunk of cheap `{ totalCount }` fields, run with
    // bounded concurrency. Each repo's profile is recorded immediately so the
    // detail page fills in counts while the run is still in progress. A counts
    // chunk that fails (after the internal split/degrade) fails the run.
    const signalsByRepo = new Map<string, RepoSignals>();
    let profiled = 0;
    {
      const chunks = chunk(discovery.repos, COUNTS_CHUNK);
      let firstError: unknown = null;
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < chunks.length && firstError === null) {
          const c = chunks[next++];
          if (!c) break;
          try {
            const chunkSignals = await d.augmentCounts(gql, c);
            for (const signals of chunkSignals) {
              recordRepoProfile(input.id, signals, analyzeRepo(signals));
              signalsByRepo.set(signals.nameWithOwner, signals);
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
              `[profile] run ${input.id} counts chunk failed — ${c.length} repo(s):`,
              err,
            );
            if (firstError === null) firstError = err;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(AUGMENT_CONCURRENCY, chunks.length) }, () => worker()),
      );
      if (firstError !== null) throw firstError;
    }
    console.log(
      `[profile] run ${input.id} counts pass done — ${profiled} repo(s) in ${Date.now() - startedMs}ms`,
    );

    // ── Pass 2: verification details (best-effort) ─────────────────────────
    // The expensive checks. Repos with no releases skip the release-asset scan
    // and batch wider; repos with releases batch narrower. Each result merges
    // onto the already-recorded counts and re-records. This pass is NON-fatal:
    // the counts are already persisted, so a details failure enriches less but
    // never fails the run.
    const withReleases = discovery.repos.filter((r) => r.releasesCount > 0);
    const withoutReleases = discovery.repos.filter((r) => r.releasesCount === 0);
    const tasks: Array<{ repos: typeof discovery.repos; scanReleases: boolean }> = [
      ...chunk(withoutReleases, DETAILS_CHUNK_LITE).map((repos) => ({
        repos,
        scanReleases: false,
      })),
      ...chunk(withReleases, DETAILS_CHUNK_FULL).map((repos) => ({ repos, scanReleases: true })),
    ];
    {
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < tasks.length) {
          const task = tasks[next++];
          if (!task) break;
          try {
            const details = await d.augmentDetails(gql, task.repos, {
              scanReleases: task.scanReleases,
            });
            for (const det of details) {
              const base = signalsByRepo.get(det.nameWithOwner);
              if (!base) continue;
              const merged: RepoSignals = {
                ...base,
                commitsCount: det.commitsCount,
                branchProtectionRulesUsingUnmigratedFeatures:
                  det.branchProtectionRulesUsingUnmigratedFeatures,
                usesLfs: det.usesLfs,
                workflowFileCount: det.workflowFileCount,
                releaseAssetBytes: det.releaseAssetBytes,
              };
              signalsByRepo.set(det.nameWithOwner, merged);
              recordRepoProfile(input.id, merged, analyzeRepo(merged));
            }
            // Nudge any live watcher to refetch the now-enriched data.
            onProgress?.({ runId: input.id, profiled, total: discovery.total, repo: "" });
          } catch (err) {
            console.error(
              `[profile] run ${input.id} details chunk failed — ${task.repos.length} repo(s), scanReleases=${task.scanReleases} (counts kept):`,
              err,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(AUGMENT_CONCURRENCY, tasks.length) }, () => worker()),
      );
    }

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
