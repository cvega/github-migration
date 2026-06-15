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
 * Repos per augment request. Each chunk is one aliased GraphQL query; 25 keeps
 * the per-request node budget (≤ 25 × 100 branch-protection rules) and query
 * complexity comfortably within GitHub's limits while cutting requests 25×.
 */
const AUGMENT_CHUNK = 25;

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

    // Profile repos in chunks: each `augment` call is one aliased GraphQL
    // request covering up to AUGMENT_CHUNK repos, so an org of N repos costs
    // ~N/AUGMENT_CHUNK requests instead of one per repo.
    let profiled = 0;
    for (let i = 0; i < discovery.repos.length; i += AUGMENT_CHUNK) {
      const chunk = discovery.repos.slice(i, i + AUGMENT_CHUNK);
      const chunkSignals = await d.augment(gql, chunk);
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
