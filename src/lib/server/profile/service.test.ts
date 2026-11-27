import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { createProfileClient } from "$lib/server/core/github";
import { getProfileRun } from "./database/runs";
import { profileStore, recoverInterruptedProfiles } from "./database/schema";
import { runProfile } from "./runner";
import { getProfileDetail, startOrgProfile, stopActiveProfileRuns } from "./service";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

test("creates a queryable run before background profiling settles", async () => {
  let settle!: (value: never) => void;
  const pending = new Promise<never>((resolve) => {
    settle = resolve;
  });
  const run = startOrgProfile("acme", {
    buildSourceClients: () =>
      ({
        gql: async () => ({}),
        rest: {},
        sourceApiUrl: "https://api.github.com",
        getApiCalls: () => 0,
      }) as never,
    run: () => pending,
    newId: () => "run",
  });
  expect(run).toMatchObject({ id: "run", state: "running", org: "acme" });
  expect(getProfileDetail("run")?.run.id).toBe("run");
  settle(run as never);
  await Promise.resolve();
});

test("persists a generic failure when a background runner crashes", async () => {
  startOrgProfile("acme", {
    buildSourceClients: () =>
      ({
        gql: async () => ({}),
        rest: {},
        sourceApiUrl: "https://api.github.com",
        getApiCalls: () => 0,
      }) as never,
    run: async () => {
      throw new Error("secret internal detail");
    },
    newId: () => "failed",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getProfileDetail("failed")?.run).toMatchObject({
    state: "failed",
    failureReason: "Organization profiling failed",
  });
});

test("shutdown fences admission and waits for an aborted discovery retry to settle", async () => {
  const queued = Promise.withResolvers<void>();
  const releaseRetry = Promise.withResolvers<void>();
  let attempts = 0;
  let id = 0;
  const deps = {
    newId: () => String(++id),
    buildSourceClients(signal?: AbortSignal) {
      if (!signal) throw new Error("missing run signal");
      const rest = createProfileClient({ token: "fixture" }, "https://github.example", signal, {
        fetch: async () => {
          attempts++;
          return attempts === 1
            ? Response.json({}, { status: 429, headers: { "retry-after": "20" } })
            : Response.json([]);
        },
        wait: async () => {
          queued.resolve();
          await releaseRetry.promise;
        },
      });
      return {
        rest,
        gql: rest.graphql,
        sourceApiUrl: "https://github.example",
        getApiCalls: () => attempts,
      };
    },
    run: runProfile,
  };
  startOrgProfile("acme", deps);
  await queued.promise;
  let settled = false;
  const shutdown = Promise.resolve(stopActiveProfileRuns()).then(() => {
    settled = true;
  });
  await Bun.sleep(0);
  try {
    expect(settled).toBe(false);
    expect(getProfileDetail("1")?.run.state).toBe("running");
    expect(() => startOrgProfile("acme", deps)).toThrow("shutting down");
  } finally {
    releaseRetry.resolve();
    await shutdown;
  }
  expect(attempts).toBe(1);
  expect(getProfileDetail("1")?.run).toMatchObject({
    state: "failed",
    failureReason: "Profile worker cancelled",
    apiCalls: 1,
  });
});

test("shutdown snapshots dispatched calls when settlement exceeds the deadline", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let apiCalls = 0;
  startOrgProfile("acme", {
    newId: () => "unfinished",
    buildSourceClients: () =>
      ({
        rest: {},
        sourceApiUrl: "https://github.example",
        getApiCalls: () => apiCalls,
      }) as never,
    run: async () => {
      apiCalls++;
      started.resolve();
      await release.promise;
      try {
        const run = getProfileRun("unfinished");
        if (!run) throw new Error("missing fixture run");
        return run;
      } finally {
        finished.resolve();
      }
    },
  });
  await started.promise;
  try {
    expect(await stopActiveProfileRuns(0)).toBe(false);
    expect(getProfileRun("unfinished")).toMatchObject({ state: "running", apiCalls: 1 });
    recoverInterruptedProfiles(getDb());
    expect(getProfileRun("unfinished")).toMatchObject({
      state: "failed",
      failureReason: "Server restarted during profiling",
      apiCalls: 1,
    });
  } finally {
    release.resolve();
    await finished.promise;
  }
});
