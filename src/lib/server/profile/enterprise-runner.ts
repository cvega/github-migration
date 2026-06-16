/**
 * Enterprise runner — orchestrates an enterprise-scoped readiness profile:
 *
 *   enumerate orgs → profile each org (child run) → aggregate → persist
 *
 * It owns the enterprise run lifecycle: it creates the run, records the org
 * total, spawns one child {@link runProfile} per organization (bounded so the
 * combined API pressure stays sane), refreshes the parent's aggregates as each
 * child settles, and marks the enterprise run completed — or, if org
 * enumeration fails, marks it failed with the reason. Like the org runner it
 * never throws for a profiling failure; the persisted enterprise run is the
 * source of truth.
 *
 * The crawl primitives (`discoverOrgs`, `runOrg`) are injected with real
 * defaults, so the orchestration — enumeration, bounded fan-out, aggregate
 * refresh, progress, and failure handling — is unit-testable against a real
 * in-memory store without a network.
 */
import { clearPause, isPauseRequested } from "./control";
import { discoverEnterpriseOrgs } from "./enterprise";
import type { ProfileClients } from "./runner";
import { runProfile } from "./runner";
import {
  completeEnterpriseRun,
  createEnterpriseRun,
  failEnterpriseRun,
  getEnterpriseChildRuns,
  getEnterpriseRun,
  pauseEnterpriseRun,
  refreshEnterpriseRunAggregates,
  resetEnterpriseRunForResume,
  setEnterpriseRunTotalOrgs,
} from "./store";
import type { EnterpriseProgress, EnterpriseRun, ProfileRun } from "./types";

/**
 * How many organizations are profiled concurrently. Each org's `runProfile`
 * already pools its own per-repo requests, so running several orgs at once
 * multiplies API pressure; keep this low to stay well under rate limits while
 * still overlapping wall-clock.
 */
const ORG_CONCURRENCY = 2;

/** Injectable enterprise-crawl primitives (defaults hit the real helpers). */
export interface EnterpriseRunnerDeps {
  /** List the enterprise's organization logins (GraphQL). */
  discoverOrgs: typeof discoverEnterpriseOrgs;
  /**
   * Profile one organization as a child of this enterprise run. The service
   * binds this to {@link runProfile} with a child-scoped SSE publisher and the
   * REST-backed org-resource deps; the default is a bare `runProfile`.
   */
  runOrg: (
    clients: ProfileClients,
    input: {
      id: string;
      org: string;
      sourceApiUrl: string;
      enterpriseRunId: string;
      resume?: boolean;
    },
  ) => Promise<ProfileRun>;
  /** Generate a child run id. */
  newId: () => string;
  /**
   * Whether a pause has been requested for this enterprise run id. Checked
   * before starting each org so a paused enterprise stops fanning out; the
   * in-flight children are paused independently (by their own run id). Default
   * reads the in-memory pause registry; tests inject a deterministic predicate.
   */
  shouldPause: (runId: string) => boolean;
}

const DEFAULT_DEPS: EnterpriseRunnerDeps = {
  discoverOrgs: discoverEnterpriseOrgs,
  runOrg: (clients, input) => runProfile(clients, input),
  newId: () => Bun.randomUUIDv7(),
  shouldPause: isPauseRequested,
};

/** Concise failure reason from an enumeration error (mirrors the org runner). */
function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { status?: number; message?: string };
    const parts: string[] = [];
    if (typeof e.status === "number") parts.push(`HTTP ${e.status}`);
    if (e.message) parts.push(e.message);
    if (parts.length > 0) return parts.join(": ");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Profile an entire enterprise: enumerate its organizations and run one child
 * org profile per org, aggregating their results onto the enterprise run.
 *
 * The enterprise run is created synchronously (before the first `await`), so the
 * caller can return it immediately while the crawl proceeds in the background.
 *
 * @param clients    Injected source clients (GraphQL enumeration, plus whatever
 *                   each child org run needs).
 * @param input      Run id, enterprise slug, and the source API URL.
 * @param onProgress Optional enterprise-level progress callback (drives SSE).
 * @param deps       Injectable crawl primitives (defaults to the real ones).
 * @returns          The final persisted enterprise run — `completed` or `failed`.
 */
export async function runEnterpriseProfile(
  clients: ProfileClients,
  input: { id: string; enterpriseSlug: string; sourceApiUrl: string; resume?: boolean },
  onProgress?: (progress: EnterpriseProgress) => void,
  deps: Partial<EnterpriseRunnerDeps> = {},
): Promise<EnterpriseRun> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const startedMs = Date.now();
  if (input.resume) {
    // Resume an interrupted enterprise run: keep its child runs and just flip it
    // back to `running`. Below, orgs whose child already completed are skipped
    // and the rest are resumed or started fresh.
    resetEnterpriseRunForResume(input.id);
    console.log(
      `[profile] enterprise run ${input.id} resuming — slug=${input.enterpriseSlug}, source=${input.sourceApiUrl}`,
    );
  } else {
    createEnterpriseRun({
      id: input.id,
      sourceApiUrl: input.sourceApiUrl,
      enterpriseSlug: input.enterpriseSlug,
    });
    console.log(
      `[profile] enterprise run ${input.id} started — slug=${input.enterpriseSlug}, source=${input.sourceApiUrl}`,
    );
  }

  try {
    onProgress?.({
      enterpriseRunId: input.id,
      phase: "enumerating",
      totalOrgs: 0,
      profiledOrgs: 0,
      org: "",
    });

    // On resume, the child runs the original crawl recorded already define the
    // resumable work; re-enumerating only adds orgs joined to the enterprise
    // since. So a resume tolerates an enumeration failure — it falls back to the
    // orgs it already knows rather than throwing away partial progress (the
    // enterprise GraphQL connection can transiently resolve to null on a token
    // change, rate-limit, or hiccup). A fresh run has no children to fall back
    // to, so its enumeration failure stays fatal.
    const existingChild = input.resume
      ? new Map(getEnterpriseChildRuns(input.id).map((c) => [c.org, c]))
      : new Map<string, ProfileRun>();

    let orgs: string[];
    if (input.resume) {
      let enumerated: string[] = [];
      try {
        enumerated = await d.discoverOrgs(clients.gql, input.enterpriseSlug);
      } catch (err) {
        if (existingChild.size === 0) throw err; // nothing recorded to fall back to
        console.warn(
          `[profile] enterprise run ${input.id} resume: re-enumeration failed ` +
            `(${describeError(err)}); resuming the ${existingChild.size} known org(s)`,
        );
      }
      // Union the known children (stable, name-ordered) with any newly-found
      // orgs, so resume always covers what was started and picks up new orgs
      // when enumeration succeeds.
      orgs = [...new Set<string>([...existingChild.keys(), ...enumerated])];
    } else {
      orgs = await d.discoverOrgs(clients.gql, input.enterpriseSlug);
    }

    setEnterpriseRunTotalOrgs(input.id, orgs.length);
    console.log(
      `[profile] enterprise run ${input.id} enumerated ${orgs.length} org(s) in ${Date.now() - startedMs}ms`,
    );
    onProgress?.({
      enterpriseRunId: input.id,
      phase: "organizations",
      totalOrgs: orgs.length,
      profiledOrgs: 0,
      org: "",
    });

    // Fan out child org runs with bounded concurrency. Each child is best-effort
    // (runProfile records its own failure on the child run and never throws), so
    // one bad org doesn't abort the enterprise crawl. As each settles, refresh
    // the parent's aggregates and nudge any live watcher.
    //
    // On resume, an org whose child run already completed is skipped; one with an
    // existing (unfinished) child is resumed on that same child; a brand-new org
    // is started fresh.
    let settled = input.resume
      ? [...existingChild.values()].filter((c) => c.state === "completed").length
      : 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < orgs.length) {
        // Honor a pause: stop starting new orgs. In-flight children are paused
        // independently (by their own run id) and settle as `paused`.
        if (d.shouldPause(input.id)) break;
        const org = orgs[next++];
        if (!org) break;
        const child = existingChild.get(org);
        if (child?.state === "completed") continue; // already done — skip

        await d.runOrg(clients, {
          id: child ? child.id : d.newId(),
          org,
          sourceApiUrl: input.sourceApiUrl,
          enterpriseRunId: input.id,
          resume: child !== undefined,
        });
        settled += 1;
        refreshEnterpriseRunAggregates(input.id);
        onProgress?.({
          enterpriseRunId: input.id,
          phase: "organizations",
          totalOrgs: orgs.length,
          profiledOrgs: settled,
          org,
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ORG_CONCURRENCY, orgs.length) }, () => worker()),
    );

    if (d.shouldPause(input.id)) {
      // Honored a pause: leave the enterprise (and its children) resumable.
      pauseEnterpriseRun(input.id);
      const paused = getEnterpriseRun(input.id);
      console.log(
        `[profile] enterprise run ${input.id} paused — ${paused?.profiledOrgs ?? 0} org(s) done ` +
          `in ${Date.now() - startedMs}ms`,
      );
    } else {
      completeEnterpriseRun(input.id);
      const completed = getEnterpriseRun(input.id);
      console.log(
        `[profile] enterprise run ${input.id} completed — ${completed?.profiledOrgs ?? 0} org(s), ` +
          `${completed?.totalRepos ?? 0} repo(s) in ${Date.now() - startedMs}ms`,
      );
    }
  } catch (err) {
    const reason = describeError(err);
    console.error(
      `[profile] enterprise run ${input.id} failed after ${Date.now() - startedMs}ms — ${reason}`,
      err,
    );
    failEnterpriseRun(input.id, reason);
  }

  // Drop any pause request now the enterprise run has settled.
  clearPause(input.id);
  const run = getEnterpriseRun(input.id);
  if (!run) throw new Error(`Enterprise run '${input.id}' vanished after execution`);
  return run;
}
