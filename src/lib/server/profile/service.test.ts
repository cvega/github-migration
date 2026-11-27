import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { createProfileClient } from "$lib/server/core/github";
import { sleep } from "$lib/server/core/polling";
import { profileStore } from "./database/schema";
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

test("shutdown cancels discovery retry and releases the GitHub lane", async () => {
  const queued = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
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
        wait: (delay, signal) => {
          queued.resolve();
          return sleep(delay, signal);
        },
      });
      return {
        rest,
        gql: rest.graphql,
        sourceApiUrl: "https://github.example",
        getApiCalls: () => attempts,
      };
    },
    run: async (...args: Parameters<typeof runProfile>) => {
      const run = await runProfile(...args);
      settled.resolve();
      return run;
    },
  };
  startOrgProfile("acme", deps);
  await queued.promise;
  stopActiveProfileRuns();
  await settled.promise;
  expect(attempts).toBe(1);
  expect(getProfileDetail("1")?.run).toMatchObject({
    state: "failed",
    failureReason: "Profile worker cancelled",
  });
  expect(startOrgProfile("acme", { ...deps, run: runProfile }).state).toBe("running");
  stopActiveProfileRuns();
  await Bun.sleep(0);
});
