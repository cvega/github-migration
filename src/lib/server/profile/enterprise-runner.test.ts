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
import { clearPause, requestPause } from "./control";
import { type EnterpriseRunnerDeps, runEnterpriseProfile } from "./enterprise-runner";
import type { ProfileClients } from "./runner";
import {
  completeEnterpriseRun,
  completeProfileRun,
  createEnterpriseRun,
  createProfileRun,
  failEnterpriseRun,
  failProfileRun,
  getEnterpriseChildRuns,
  getProfileRun,
  pauseEnterpriseRun,
  pauseProfileRun,
  resetProfileRunForResume,
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
 * aggregate refresh reads real persisted children. On a resume call (an existing
 * child) it doesn't recreate the row; `inputs` records the full call for resume
 * assertions while `calls` keeps the org-name list the older tests use.
 */
function fakeRunOrg(opts: { totals?: Record<string, number>; fail?: string[] } = {}) {
  const calls: string[] = [];
  const inputs: Array<{ id: string; org: string; resume: boolean }> = [];
  const failSet = new Set(opts.fail ?? []);
  const runOrg: EnterpriseRunnerDeps["runOrg"] = async (_clients, input) => {
    calls.push(input.org);
    inputs.push({ id: input.id, org: input.org, resume: !!input.resume });
    if (input.resume) {
      resetProfileRunForResume(input.id); // existing child — continue it
    } else {
      createProfileRun({
        id: input.id,
        sourceApiUrl: input.sourceApiUrl,
        org: input.org,
        enterpriseRunId: input.enterpriseRunId,
      });
    }
    const total = opts.totals?.[input.org];
    if (total !== undefined) setProfileRunTotal(input.id, total);
    if (failSet.has(input.org)) failProfileRun(input.id, "org crawl failed");
    else completeProfileRun(input.id);
    const run = getProfileRun(input.id);
    if (!run) throw new Error("fakeRunOrg: child run missing");
    return run;
  };
  return { runOrg, calls, inputs };
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
    discoverOrgs: async () => ({ orgs, inaccessible: 0 }),
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

  test("records how many orgs the token couldn't access", async () => {
    const { runOrg } = fakeRunOrg();
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" },
      undefined,
      {
        runOrg,
        newId: seqIds(),
        // Two accessible orgs; seven forbid the token (e.g. classic-PAT policy).
        discoverOrgs: async () => ({ orgs: ["alpha", "beta"], inaccessible: 7 }),
      },
    );
    expect(run.totalOrgs).toBe(2); // only accessible orgs are profiled
    expect(run.inaccessibleOrgs).toBe(7); // surfaced so the UI can explain the gap
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

  test("resume skips completed orgs, resumes unfinished ones, and starts new ones", async () => {
    // An interrupted enterprise: alpha already finished, beta was mid-flight,
    // gamma never started (it only shows up in the fresh org enumeration).
    createEnterpriseRun({ id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" });
    createProfileRun({ id: "c-alpha", sourceApiUrl: "u", org: "alpha", enterpriseRunId: "ent" });
    completeProfileRun("c-alpha");
    createProfileRun({ id: "c-beta", sourceApiUrl: "u", org: "beta", enterpriseRunId: "ent" });
    // c-beta stays `running` — it was interrupted.

    const { runOrg, inputs } = fakeRunOrg();
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u", resume: true },
      undefined,
      deps(["alpha", "beta", "gamma"], { runOrg }),
    );

    // alpha is skipped entirely; beta + gamma are (re)dispatched.
    expect(inputs.map((i) => i.org).sort()).toEqual(["beta", "gamma"]);
    // beta resumes on its existing child id, gamma is a fresh child.
    const beta = inputs.find((i) => i.org === "beta");
    expect(beta?.id).toBe("c-beta");
    expect(beta?.resume).toBe(true);
    const gamma = inputs.find((i) => i.org === "gamma");
    expect(gamma?.resume).toBe(false);
    expect(gamma?.id).not.toBe("c-beta");

    // Every org ends with exactly one child row and the run completes.
    expect(run.state).toBe("completed");
    expect(
      getEnterpriseChildRuns("ent")
        .map((c) => c.org)
        .sort(),
    ).toEqual(["alpha", "beta", "gamma"]);
    expect(run.profiledOrgs).toBe(3);
  });

  test("resume of an already-finished enterprise re-runs nothing", async () => {
    createEnterpriseRun({ id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" });
    createProfileRun({ id: "c-alpha", sourceApiUrl: "u", org: "alpha", enterpriseRunId: "ent" });
    completeProfileRun("c-alpha");
    completeEnterpriseRun("ent");

    const { runOrg, inputs } = fakeRunOrg();
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u", resume: true },
      undefined,
      deps(["alpha"], { runOrg }),
    );

    expect(inputs).toEqual([]); // alpha already completed — nothing dispatched
    expect(run.state).toBe("completed");
    expect(run.profiledOrgs).toBe(1);
  });

  test("a pause request halts the org fan-out and settles the enterprise paused", async () => {
    const started: string[] = [];
    // The first org to run requests a pause (as the user clicking Pause would),
    // so the runner stops before starting any further orgs.
    const runOrg: EnterpriseRunnerDeps["runOrg"] = async (_c, input) => {
      started.push(input.org);
      createProfileRun({
        id: input.id,
        sourceApiUrl: input.sourceApiUrl,
        org: input.org,
        enterpriseRunId: input.enterpriseRunId,
      });
      completeProfileRun(input.id);
      requestPause(input.enterpriseRunId);
      const run = getProfileRun(input.id);
      if (!run) throw new Error("missing child");
      return run;
    };

    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" },
      undefined,
      deps(["alpha", "beta", "gamma", "delta"], { runOrg }),
    );
    expect(run.state).toBe("paused");
    // Only the first org ran before the pause was observed; the rest never start.
    expect(started).toEqual(["alpha"]);
    expect(getEnterpriseChildRuns("ent").map((c) => c.org)).toEqual(["alpha"]);
    clearPause("ent"); // tidy the shared registry for later tests
  });

  test("resume continues a paused enterprise: skip done, resume paused, start new", async () => {
    createEnterpriseRun({ id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" });
    createProfileRun({ id: "c-alpha", sourceApiUrl: "u", org: "alpha", enterpriseRunId: "ent" });
    completeProfileRun("c-alpha");
    createProfileRun({ id: "c-beta", sourceApiUrl: "u", org: "beta", enterpriseRunId: "ent" });
    pauseProfileRun("c-beta"); // a child paused when the enterprise was paused
    pauseEnterpriseRun("ent");

    const { runOrg, inputs } = fakeRunOrg();
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u", resume: true },
      undefined,
      deps(["alpha", "beta", "gamma"], { runOrg }),
    );
    // alpha skipped (completed); beta resumed on its existing id; gamma fresh.
    expect(inputs.map((i) => i.org).sort()).toEqual(["beta", "gamma"]);
    const beta = inputs.find((i) => i.org === "beta");
    expect(beta?.id).toBe("c-beta");
    expect(beta?.resume).toBe(true);
    expect(inputs.find((i) => i.org === "gamma")?.resume).toBe(false);
    expect(run.state).toBe("completed");
  });

  test("resume falls back to known children when re-enumeration fails", async () => {
    // A paused enterprise with two children — one done, one still pending. The
    // fresh enumeration throws (e.g. the enterprise transiently resolves to null
    // on resume), but the recorded children must still be resumable.
    createEnterpriseRun({ id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u" });
    createProfileRun({ id: "c-alpha", sourceApiUrl: "u", org: "alpha", enterpriseRunId: "ent" });
    completeProfileRun("c-alpha");
    createProfileRun({ id: "c-beta", sourceApiUrl: "u", org: "beta", enterpriseRunId: "ent" });
    pauseProfileRun("c-beta");
    pauseEnterpriseRun("ent");

    const { runOrg, inputs } = fakeRunOrg();
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "acme", sourceApiUrl: "u", resume: true },
      undefined,
      deps([], {
        runOrg,
        discoverOrgs: async () => {
          throw new Error("Enterprise 'acme' not found or not accessible");
        },
      }),
    );
    // The enumeration failure was tolerated: the known unfinished child resumed,
    // the completed one was skipped, and the run finished rather than failing.
    expect(run.state).toBe("completed");
    expect(inputs.map((i) => i.org)).toEqual(["beta"]);
    expect(inputs[0]?.id).toBe("c-beta");
    expect(inputs[0]?.resume).toBe(true);
  });

  test("resume still fails when enumeration throws and there are no children", async () => {
    // An enterprise run that failed before recording any child — there's nothing
    // to fall back to, so a resume that can't enumerate fails again (correctly).
    createEnterpriseRun({ id: "ent", enterpriseSlug: "ghost", sourceApiUrl: "u" });
    failEnterpriseRun("ent", "Enterprise 'ghost' not found or not accessible");

    const { runOrg, inputs } = fakeRunOrg();
    const run = await runEnterpriseProfile(
      clients,
      { id: "ent", enterpriseSlug: "ghost", sourceApiUrl: "u", resume: true },
      undefined,
      deps([], {
        runOrg,
        discoverOrgs: async () => {
          throw new Error("Enterprise 'ghost' not found or not accessible");
        },
      }),
    );
    expect(run.state).toBe("failed");
    expect(run.failureReason).toContain("not found or not accessible");
    expect(inputs).toEqual([]); // nothing was dispatched
  });
});
