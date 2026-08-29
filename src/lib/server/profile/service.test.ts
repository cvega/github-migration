import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { profileStore } from "./database/schema";
import { getProfileDetail, startOrgProfile } from "./service";

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
