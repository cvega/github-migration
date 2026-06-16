/**
 * Tests for the enterprise runner's orchestration: enumerate the enterprise's
 * orgs, run a child profile per org, aggregate onto the parent, and handle
 * enumeration failure. Crawl primitives are injected, and child org runs are
 * simulated with the real store (so the parent's aggregate refresh is exercised)
 * — no network. The detailed aggregate math is covered in store.test.ts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { initStore } from "$lib/server/core/db";
import { DOMAIN_STORES } from "$lib/server/registry";
import { type EnterpriseRunnerDeps, runEnterpriseProfile } from "./enterprise-runner";
import type { ProfileClients } from "./runner";
import {
  completeProfileRun,
  createProfileRun,
  failProfileRun,
  getEnterpriseChildRuns,
  getProfileRun,
  setProfileRunTotal,
} from "./store";
import type { EnterpriseProgress } from "./types";

const clients = { getApiCalls: () => 0 } as unknown as ProfileClients;

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
});

/**
 * A `runOrg` double that creates a real child run linked to the enterprise,
 * sets its repo total, and completes (or fails) it — so the enterprise runner's
 * aggregate refresh reads real persisted children.
 */
function fakeRunOrg(opts: { totals?: Record<string, number>; fail?: string[] } = {}) {
  const calls: string[] = [];
  const failSet = new Set(opts.fail ?? []);
  const runOrg: EnterpriseRunnerDeps["runOrg"] = async (_clients, input) => {
    calls.push(input.org);
    createProfileRun({
      id: input.id,
      sourceApiUrl: input.sourceApiUrl,
      org: input.org,
      enterpriseRunId: input.enterpriseRunId,
    });
    const total = opts.totals?.[input.org];
    if (total !== undefined) setProfileRunTotal(input.id, total);
    if (failSet.has(input.org)) failProfileRun(input.id, "org crawl failed");
    else completeProfileRun(input.id);
    const run = getProfileRun(input.id);
    if (!run) throw new Error("fakeRunOrg: child run missing");
    return run;
  };
  return { runOrg, calls };
}

/** Deterministic child ids so assertions can be stable. */
function seqIds() {
  let n = 0;
  return () => `child-${n++}`;
}

function deps(
  orgs: string[],
  over: Partial<EnterpriseRunnerDeps> = {},
): Partial<EnterpriseRunnerDeps> {
  return {
    discoverOrgs: async () => orgs,
    newId: seqIds(),
    ...over,
  };
}

describe("runEnterpriseProfile", () => {
  test("enumerates orgs, runs a child per org, and completes", async () => {
    const { runOrg, calls } = fakeRunOrg({ totals: { alpha: 3, beta: 5 } });
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" },
      undefined,
      deps(["alpha", "beta"], { runOrg }),
    );

    expect(calls.sort()).toEqual(["alpha", "beta"]);
    expect(run.state).toBe("completed");
    expect(run.totalOrgs).toBe(2);
    expect(run.profiledOrgs).toBe(2);
    expect(run.totalRepos).toBe(8); // 3 + 5 rolled up from children
    // Children are linked to the enterprise run.
    expect(getEnterpriseChildRuns("ent").map((r) => r.org)).toEqual(["alpha", "beta"]);
  });

  test("creates the enterprise run synchronously (queryable immediately)", async () => {
    const { runOrg } = fakeRunOrg();
    // Don't await: the run record must exist before the crawl settles.
    const promise = runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" },
      undefined,
      deps(["alpha"], { runOrg }),
    );
    expect(getProfileRun("child-0")).toBeNull(); // child not yet created
    const run = await promise;
    expect(run.id).toBe("ent");
  });

  test("emits enumerating then per-org progress", async () => {
    const { runOrg } = fakeRunOrg();
    const progress: EnterpriseProgress[] = [];
    await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" },
      (p) => progress.push(p),
      deps(["alpha", "beta"], { runOrg }),
    );

    expect(progress[0]).toEqual({
      enterpriseRunId: "ent",
      phase: "enumerating",
      totalOrgs: 0,
      profiledOrgs: 0,
      org: "",
    });
    // A phase nudge once the org total is known.
    expect(progress[1]).toEqual({
      enterpriseRunId: "ent",
      phase: "organizations",
      totalOrgs: 2,
      profiledOrgs: 0,
      org: "",
    });
    // One per-org settle nudge per org, with a rising profiledOrgs.
    const settles = progress.filter((p) => p.org !== "");
    expect(settles.map((p) => p.profiledOrgs)).toEqual([1, 2]);
    expect(settles.map((p) => p.org).sort()).toEqual(["alpha", "beta"]);
  });

  test("a failing org doesn't abort the enterprise crawl", async () => {
    const { runOrg, calls } = fakeRunOrg({ fail: ["beta"] });
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" },
      undefined,
      deps(["alpha", "beta", "gamma"], { runOrg }),
    );

    expect(calls.sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(run.state).toBe("completed");
    expect(run.profiledOrgs).toBe(3); // failed child still counts as settled
    // The failed child is recorded as failed.
    const children = getEnterpriseChildRuns("ent");
    expect(children.find((c) => c.org === "beta")?.state).toBe("failed");
  });

  test("completes an empty enterprise with zero orgs", async () => {
    const { runOrg, calls } = fakeRunOrg();
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" },
      undefined,
      deps([], { runOrg }),
    );
    expect(calls).toEqual([]);
    expect(run.state).toBe("completed");
    expect(run.totalOrgs).toBe(0);
    expect(run.profiledOrgs).toBe(0);
  });

  test("marks the enterprise run failed when org enumeration throws", async () => {
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "ghost", sourceApiUrl: "u" },
      undefined,
      {
        discoverOrgs: async () => {
          throw new Error("Enterprise 'ghost' not found or not accessible");
        },
        newId: seqIds(),
      },
    );
    expect(run.state).toBe("failed");
    expect(run.failureReason).toContain("not found or not accessible");
  });
});
