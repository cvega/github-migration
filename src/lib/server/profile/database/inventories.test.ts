import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import type { SourceNamespaceInventory } from "$lib/source/types";
import {
  getProfileInventory,
  getProfileInventorySummary,
  saveProfileInventory,
  settleProfileInventoryRun,
} from "./inventories";
import { createProfileRun, getProfileRun } from "./runs";
import { profileStore } from "./schema";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

const unavailable = { kind: "unavailable", reason: "not-reported" } as const;

function inventory(overrides: Partial<SourceNamespaceInventory> = {}): SourceNamespaceInventory {
  return {
    version: 1,
    provider: "gitlab",
    sourceApiUrl: "https://gitlab.example.com/api/v4",
    namespace: "platform",
    projectCount: { kind: "exact", value: 1 },
    projects: [
      {
        provider: "gitlab",
        sourceId: "1",
        path: "platform/api",
        name: "api",
        visibility: "private",
        archived: false,
        defaultBranch: "main",
        lastActivityAt: null,
        repositorySizeBytes: unavailable,
        storageSizeBytes: unavailable,
        lfsObjectsSizeBytes: unavailable,
        packagesSizeBytes: unavailable,
        wikiSizeBytes: unavailable,
        uploadsSizeBytes: unavailable,
      },
    ],
    ...overrides,
  };
}

function createRun(): void {
  createProfileRun({
    id: "run",
    sourceProvider: "gitlab",
    sourceApiUrl: "https://gitlab.example.com/api/v4",
    org: "platform",
  });
}

describe("profile source inventories", () => {
  test("round-trips normalized projects in source order and persists a compact summary", () => {
    createRun();
    const snapshot = inventory();
    saveProfileInventory("run", snapshot, 1);
    expect(getProfileInventory("run")).toEqual(snapshot);
    expect(getProfileInventorySummary("run")).toMatchObject({
      projectCount: { kind: "exact", value: 1 },
      projectsCaptured: 1,
    });
  });

  test("rejects inventory identity mismatches", () => {
    createRun();
    expect(() => saveProfileInventory("run", inventory({ namespace: "other" }))).toThrow(
      "Inventory namespace does not match the profile run",
    );
    expect(() =>
      saveProfileInventory("run", inventory({ sourceApiUrl: "https://other.example.com/api/v4" })),
    ).toThrow("Inventory source API URL does not match the profile run");
  });

  test("atomically settles available inventories with API cost", () => {
    createRun();
    settleProfileInventoryRun("run", inventory(), 17, 2);
    expect(getProfileRun("run")).toMatchObject({
      state: "completed",
      totalRepos: 1,
      profiledRepos: 1,
      apiCalls: 17,
      completedAt: new Date(2).toISOString(),
    });
  });

  test("fails unavailable inventories while retaining their observation", () => {
    createRun();
    const snapshot = inventory({
      projectCount: { kind: "unavailable", reason: "forbidden" },
      projects: [],
    });
    settleProfileInventoryRun("run", snapshot, 5, 3);
    expect(getProfileInventory("run")).toEqual(snapshot);
    expect(getProfileRun("run")).toMatchObject({
      state: "failed",
      apiCalls: 5,
      failureReason: "GitLab namespace inventory unavailable: forbidden",
    });
  });
});
