/**
 * Tests for the Profile domain's startup recovery. A profile crawl runs
 * entirely in-process, so a run left in `running` by a restart can never settle
 * and must be failed on the next boot. Each test runs against a fresh in-memory
 * store with an injected clock.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { getDb, initStore } from "$lib/server/core/db";
import { DOMAIN_STORES } from "$lib/server/registry";
import { recoverInterruptedProfiles } from "./schema";
import { completeProfileRun, createProfileRun, failProfileRun, getProfileRun } from "./store";

const NOW = Date.parse("2026-06-14T00:00:00Z");

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
});

describe("recoverInterruptedProfiles", () => {
  test("fails a run left in the running state", () => {
    createProfileRun({ id: "r", sourceApiUrl: "u", org: "acme" });

    recoverInterruptedProfiles(getDb(), NOW);

    const run = getProfileRun("r");
    expect(run?.state).toBe("failed");
    expect(run?.failureReason).toBe("Server restarted during profiling");
    expect(run?.completedAt).toBe("2026-06-14T00:00:00.000Z");
  });

  test("fails every interrupted run", () => {
    createProfileRun({ id: "a", sourceApiUrl: "u", org: "acme" });
    createProfileRun({ id: "b", sourceApiUrl: "u", org: "acme" });

    recoverInterruptedProfiles(getDb(), NOW);

    expect(getProfileRun("a")?.state).toBe("failed");
    expect(getProfileRun("b")?.state).toBe("failed");
  });

  test("leaves a completed run untouched", () => {
    createProfileRun({ id: "done", sourceApiUrl: "u", org: "acme" });
    completeProfileRun("done", NOW);
    const before = getProfileRun("done");

    recoverInterruptedProfiles(getDb(), NOW);

    expect(getProfileRun("done")).toEqual(before);
  });

  test("preserves an existing failure reason", () => {
    createProfileRun({ id: "boom", sourceApiUrl: "u", org: "acme" });
    failProfileRun("boom", "discovery exploded", NOW);

    recoverInterruptedProfiles(getDb(), NOW);

    expect(getProfileRun("boom")?.failureReason).toBe("discovery exploded");
  });

  test("is a no-op when nothing is running", () => {
    expect(() => recoverInterruptedProfiles(getDb(), NOW)).not.toThrow();
  });
});
