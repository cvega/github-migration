/**
 * Profile service — the boundary between the HTTP routes and the crawl engine.
 * Starts background profiling runs and assembles run detail for the UI, keeping
 * the route handlers thin.
 *
 * Dependencies (source-client builder, the runner, the id generator) are
 * injectable so the orchestration is testable against a real in-memory store
 * with no network.
 */
import { getSourceGraphql } from "$lib/server/auth";
import { runProfile } from "./runner";
import { getProfileRun, getRunRepoProfiles } from "./store";
import type { ProfileRun, StoredRepoProfile } from "./types";

/** Injectable service dependencies (defaults use the real implementations). */
export interface ProfileServiceDeps {
  buildSourceGql: typeof getSourceGraphql;
  run: typeof runProfile;
  newId: () => string;
}

const DEFAULT_DEPS: ProfileServiceDeps = {
  buildSourceGql: getSourceGraphql,
  run: runProfile,
  newId: () => Bun.randomUUIDv7(),
};

/** A run plus its per-repo results, for the detail view. */
export interface ProfileDetail {
  run: ProfileRun;
  repos: StoredRepoProfile[];
}

/**
 * Start profiling an organization in the background.
 *
 * The run record is created synchronously (the runner creates it before its
 * first `await`), so the returned run is immediately queryable; the crawl then
 * proceeds without blocking the request. The persisted run is the source of
 * truth — failures are recorded on it (state=failed), and slice 4b adds
 * restart-recovery + live progress on top of this.
 *
 * @throws when no source credentials are configured (the route maps this to a
 *         400 before the crawl starts).
 */
export function startOrgProfile(org: string, deps: ProfileServiceDeps = DEFAULT_DEPS): ProfileRun {
  const { gql, sourceApiUrl } = deps.buildSourceGql();
  const id = deps.newId();

  deps.run(gql, { id, org, sourceApiUrl }).catch((err) => {
    // The runner already persists failures on the run; this guards against an
    // unexpected throw escaping the background promise.
    console.error(`[profile] run ${id} crashed:`, err);
  });

  const run = getProfileRun(id);
  if (!run) throw new Error("profile run was not created");
  return run;
}

/** Assemble a run and its per-repo results, or null if the run is unknown. */
export function getProfileDetail(id: string): ProfileDetail | null {
  const run = getProfileRun(id);
  if (!run) return null;
  return { run, repos: getRunRepoProfiles(id) };
}
