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
import type { GitHubClient } from "$lib/server/core/github";
import { analyzeRepo } from "./analyze";
import { augmentRepoCounts, augmentRepoDetails, baseSignals } from "./augment";
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

/** Source clients the runner needs: REST for discovery (the reliable repo
 *  listing), GraphQL for the batched augment passes (indexed counts + details). */
export interface ProfileClients {
  gql: typeof graphql;
  rest: GitHubClient;
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
 * @param clients    Injected source clients (REST for discovery, GraphQL for augment).
 * @param input      Run id, org login, and the source API URL being profiled.
 * @param onProgress Optional per-repo progress callback (drives SSE later).
 * @param deps       Injectable crawl primitives (defaults to the real ones).
 * @returns          The final persisted run — `completed` or `failed`.
 */
export async function runProfile(
  clients: ProfileClients,
  input: { id: string; org: string; sourceApiUrl: string },
  onProgress?: (progress: ProfileProgress) => void,
  deps: Partial<ProfileRunnerDeps> = {},
): Promise<ProfileRun> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const startedMs = Date.now();
  createProfileRun({ id: input.id, sourceApiUrl: input.sourceApiUrl, org: input.org });
  console.log(`[profile] run ${input.id} started — org=${input.org}, source=${input.sourceApiUrl}`);

  try {
    // REST discovery lists the whole org cheaply. It doesn't report an org total
    // up front, so each page nudges the run total with the running count (and a
    // live watcher with it); the exact total lands once discovery completes.
    const discovery = await d.discover(clients.rest, input.org, (p) => {
      setProfileRunTotal(input.id, p.total);
      onProgress?.({ runId: input.id, profiled: 0, total: p.total, repo: "" });
    });
    setProfileRunTotal(input.id, discovery.total);
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

    // ── Record the list up front ──────────────────────────────────────────
    // Every discovered repo is recorded immediately with the discovery spine and
    // its augmented fields zeroed, so the detail page shows the FULL list the
    // moment discovery finishes — exactly the "list of repos" the user wants
    // before any enrichment. The two passes below fill each repo in place and
    // are best-effort: a transient GraphQL 502 in either enriches fewer repos
    // but can never empty the list or fail the run.
    const signalsByRepo = new Map<string, RepoSignals>();
    for (const repo of discovery.repos) {
      const base = baseSignals(repo);
      signalsByRepo.set(repo.nameWithOwner, base);
      recordRepoProfile(input.id, base, analyzeRepo(base));
    }
    if (discovery.repos.length > 0) {
      // Nudge any live watcher to render the freshly-listed repos.
      onProgress?.({ runId: input.id, profiled: 0, total: discovery.total, repo: "" });
    }

    // ── Pass 1: cheap counts (best-effort) ────────────────────────────────
    // One aliased request per chunk of cheap `{ totalCount }`/scalar fields, run
    // with bounded concurrency; each repo's counts are recorded as they arrive.
    // `augmentCounts` already splits/degrades on a GitHub 502 timeout, so a
    // chunk reaching this catch failed for some other reason — we log it and
    // move on, leaving those repos at their base signals rather than failing the
    // whole run.
    let profiled = 0;
    {
      const chunks = chunk(discovery.repos, COUNTS_CHUNK);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < chunks.length) {
          const c = chunks[next++];
          if (!c) break;
          try {
            const chunkSignals = await d.augmentCounts(clients.gql, c);
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
              `[profile] run ${input.id} counts chunk failed — ${c.length} repo(s) kept at base signals:`,
              err,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(AUGMENT_CONCURRENCY, chunks.length) }, () => worker()),
      );
    }
    console.log(
      `[profile] run ${input.id} counts pass done — ${profiled} repo(s) enriched in ${Date.now() - startedMs}ms`,
    );

    // ── Pass 2: verification details (best-effort) ─────────────────────────
    // The expensive checks. Repos with no releases skip the release-asset scan
    // and batch wider; repos with releases batch narrower. The release count
    // comes from the counts pass above (signalsByRepo), defaulting to 0 for any
    // repo whose counts didn't land — so it simply skips the scan. Each result
    // merges onto the already-recorded counts and re-records. This pass is
    // NON-fatal: the counts are already persisted, so a details failure enriches
    // less but never fails the run.
    const releasesOf = (nameWithOwner: string) =>
      signalsByRepo.get(nameWithOwner)?.releasesCount ?? 0;
    const withReleases = discovery.repos.filter((r) => releasesOf(r.nameWithOwner) > 0);
    const withoutReleases = discovery.repos.filter((r) => releasesOf(r.nameWithOwner) === 0);
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
            const details = await d.augmentDetails(clients.gql, task.repos, {
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
