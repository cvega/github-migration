import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import { buildProfileDetailRollup } from "../analysis/rollup";
import {
  backfillProfileRunRollup,
  countProfileRuns,
  createProfileRun,
  failProfileRun,
  getProfileRun,
  getProfileRunRollup,
  listProfileRuns,
  ProfileRunCapacityError,
  saveProfileRunRollup,
  setProfileRunApiCalls,
  setProfileRunRulesets,
  setProfileRunTotal,
} from "./runs";
import { profileStore } from "./schema";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

describe("profile runs", () => {
  test("creates GitHub runs with durable defaults and updates running counters", () => {
    const run = createProfileRun({
      id: "run-1",
      sourceApiUrl: "https://api.github.com",
      org: "acme",
      nowMs: Date.parse("2026-08-17T12:00:00.000Z"),
    });
    expect(run).toMatchObject({
      sourceProvider: "github",
      state: "running",
      totalRepos: 0,
      profiledRepos: 0,
    });

    setProfileRunTotal(run.id, 12);
    setProfileRunRulesets(run.id, 3);
    setProfileRunApiCalls(run.id, 41);
    expect(getProfileRun(run.id)).toMatchObject({
      totalRepos: 12,
      orgRulesetCount: 3,
      apiCalls: 41,
    });
  });

  test("enforces capacity per provider lane", () => {
    createProfileRun({
      id: "gitlab-1",
      sourceProvider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      org: "platform",
      enforceCapacity: true,
    });
    expect(() =>
      createProfileRun({
        id: "gitlab-2",
        sourceProvider: "gitlab",
        sourceApiUrl: "https://gitlab.example.com/api/v4",
        org: "platform",
        enforceCapacity: true,
      }),
    ).toThrow(ProfileRunCapacityError);
    expect(() =>
      createProfileRun({
        id: "github-1",
        sourceApiUrl: "https://api.github.com",
        org: "acme",
        enforceCapacity: true,
      }),
    ).not.toThrow();
  });

  test("fails active runs and lists newest records first", () => {
    createProfileRun({
      id: "older",
      sourceApiUrl: "https://api.github.com",
      org: "acme",
      nowMs: 1,
    });
    createProfileRun({
      id: "newer",
      sourceApiUrl: "https://api.github.com",
      org: "acme",
      nowMs: 2,
    });
    failProfileRun("older", "request failed", 3);
    expect(getProfileRun("older")).toMatchObject({
      state: "failed",
      failureReason: "request failed",
      completedAt: new Date(3).toISOString(),
    });
    expect(listProfileRuns().map(({ id }) => id)).toEqual(["newer", "older"]);
    expect(countProfileRuns()).toBe(2);
  });

  test("writes active rollups and backfills only missing completed caches", () => {
    createProfileRun({
      id: "rollup",
      sourceApiUrl: "https://api.github.com",
      org: "acme",
    });
    const rollup = buildProfileDetailRollup([]);
    saveProfileRunRollup("rollup", rollup);
    expect(getProfileRunRollup("rollup")).toEqual(rollup);

    failProfileRun("rollup", "failed");
    backfillProfileRunRollup("rollup", { ...rollup, scale: { ...rollup.scale, repos: 1 } });
    expect(getProfileRunRollup("rollup")).toEqual(rollup);
  });
});
