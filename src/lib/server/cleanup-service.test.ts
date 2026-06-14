/**
 * Tests for the privileged cleanup service. The safety contract under test:
 * a destructive GitHub call (rename/delete) is made ONLY when every gate
 * passes, and NEVER on any refusal path. github is spread-mocked (only the
 * identity read + the two destructive calls are stubbed); the store is REAL
 * against an in-memory DB so no partial-module mock can leak into other suites.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DOMAIN_STORES } from "$lib/server/registry";
import type { Migration } from "../types";

let renameCalls: Array<{ owner: string; repo: string; newName: string }>;
let deleteCalls: Array<{ owner: string; repo: string }>;
let liveFacts: { nodeId: string; owner: string; name: string; createdAt: string } | null;

const NODE_ID = "R_kgDOabc123";
const START = "2026-06-01T00:00:00.000Z";

// Spread real github; override only the identity read and the destructive
// calls. Safe across files: no other suite calls these three.
const realGithub = await import("./core/github");
mock.module("$lib/server/core/github", () => ({
  ...realGithub,
  createSingleClient: () => ({}),
  getRepoFacts: async () => liveFacts,
  renameRepo: async (_c: unknown, owner: string, repo: string, newName: string) => {
    renameCalls.push({ owner, repo, newName });
    return `${owner}/${newName}`;
  },
  deleteRepo: async (_c: unknown, owner: string, repo: string) => {
    deleteCalls.push({ owner, repo });
  },
}));

const { initStore } = await import("$lib/server/core/db");
const { insertMigration, updateMigrationProvenance, getEvents } = await import("./migrate/store");
const { executeCleanup, previewCleanup } = await import("./cleanup-service");

function migration(over: Partial<Migration> = {}): Migration {
  return {
    id: "m-1",
    batchId: null,
    githubMigrationId: "RM_x",
    sourceApiUrl: "https://ghes.example.com/api/v3",
    sourceOrg: "src",
    sourceRepo: "widget",
    targetOrg: "acme-cloud",
    targetRepo: "widget",
    state: "failed",
    failureReason: "boom",
    migrationLogUrl: null,
    warningsCount: 0,
    sourceCounts: null,
    targetCounts: null,
    sourceSizeKb: null,
    startedAt: START,
    completedAt: null,
    elapsedSeconds: null,
    authMode: "env-pat",
    requestOptions: null,
    targetPreexisted: false,
    targetRepoNodeId: NODE_ID,
    ...over,
  };
}

/** Seed the in-memory store with one migration + its provenance. */
function seed(over: Partial<Migration> = {}): void {
  const m = migration(over);
  insertMigration(m);
  updateMigrationProvenance(m.id, {
    ...(m.targetPreexisted !== null ? { targetPreexisted: m.targetPreexisted } : {}),
    ...(m.targetRepoNodeId ? { targetRepoNodeId: m.targetRepoNodeId } : {}),
  });
}

function auditMessagesFor(id: string): string[] {
  return getEvents(id).map((e) => (e.eventType === "step" ? e.payload.message : ""));
}

const CONFIRM = "acme-cloud/widget";
const CLEANUP_ENV = ["TARGET_CLEANUP_DISABLED", "TARGET_CLEANUP", "GH_TARGET_ADMIN_PAT"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  initStore(":memory:", DOMAIN_STORES);
  renameCalls = [];
  deleteCalls = [];
  liveFacts = {
    nodeId: NODE_ID,
    owner: "acme-cloud",
    name: "widget",
    createdAt: "2026-06-01T00:10:00.000Z",
  };
  savedEnv = {};
  for (const k of CLEANUP_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TARGET_CLEANUP = "delete";
  process.env.GH_TARGET_ADMIN_PAT = "ghp_admin";
});

afterEach(() => {
  for (const k of CLEANUP_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function noDestructiveCalls() {
  expect(renameCalls).toHaveLength(0);
  expect(deleteCalls).toHaveLength(0);
}

describe("executeCleanup — refusals never act", () => {
  test("kill switch: no destructive call, audited refusal", async () => {
    seed();
    process.env.TARGET_CLEANUP_DISABLED = "true";
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("globally-disabled");
    noDestructiveCalls();
    expect(auditMessagesFor("m-1").some((m) => /refused/i.test(m))).toBe(true);
  });

  test("rename mode cannot delete", async () => {
    seed();
    process.env.TARGET_CLEANUP = "rename";
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    noDestructiveCalls();
  });

  test("missing admin credential refuses and never acts", async () => {
    seed();
    delete process.env.GH_TARGET_ADMIN_PAT;
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    noDestructiveCalls();
  });

  test("succeeded migration is never cleaned up", async () => {
    seed({ state: "succeeded" });
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    noDestructiveCalls();
  });

  test("pre-existing target is never touched", async () => {
    seed({ targetPreexisted: true });
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("target-preexisted");
    noDestructiveCalls();
  });

  test("node_id mismatch (delete+recreate) refuses", async () => {
    seed();
    liveFacts = liveFacts && { ...liveFacts, nodeId: "R_kgDOdifferent" };
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("node-id-mismatch");
    noDestructiveCalls();
  });

  test("created-outside-window refuses", async () => {
    seed();
    liveFacts = liveFacts && { ...liveFacts, createdAt: "2020-01-01T00:00:00.000Z" };
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("created-outside-window");
    noDestructiveCalls();
  });

  test("wrong confirmation refuses", async () => {
    seed();
    const r = await executeCleanup("m-1", "delete", "acme-cloud/not-it");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("confirmation-mismatch");
    noDestructiveCalls();
  });

  test("missing migration refuses", async () => {
    const r = await executeCleanup("nope", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("migration-not-found");
    noDestructiveCalls();
  });

  test("live repo unreadable refuses without acting", async () => {
    seed();
    liveFacts = null;
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(false);
    noDestructiveCalls();
  });
});

describe("executeCleanup — eligible paths", () => {
  test("delete: calls deleteRepo once, never rename, and audits", async () => {
    seed();
    const r = await executeCleanup("m-1", "delete", CONFIRM);
    expect(r.ok).toBe(true);
    expect(deleteCalls).toEqual([{ owner: "acme-cloud", repo: "widget" }]);
    expect(renameCalls).toHaveLength(0);
    expect(auditMessagesFor("m-1").some((m) => /deleted target/i.test(m))).toBe(true);
  });

  test("rename: calls renameRepo once with a moved-aside name, never delete", async () => {
    seed();
    process.env.TARGET_CLEANUP = "rename";
    const r = await executeCleanup("m-1", "rename", CONFIRM);
    expect(r.ok).toBe(true);
    expect(renameCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
    expect(renameCalls[0]?.newName).toMatch(/^widget-migfailed-/);
    expect(auditMessagesFor("m-1").some((m) => /renamed target/i.test(m))).toBe(true);
  });

  test("delete mode also permits rename", async () => {
    seed();
    const r = await executeCleanup("m-1", "rename", CONFIRM);
    expect(r.ok).toBe(true);
    expect(renameCalls).toHaveLength(1);
  });
});

describe("previewCleanup", () => {
  test("returns all gate statuses and never acts", async () => {
    seed();
    const p = await previewCleanup("m-1", "delete");
    expect(p?.gates).toHaveLength(10);
    expect(p?.confirmationPhrase).toBe("acme-cloud/widget");
    noDestructiveCalls();
  });

  test("ready=true when only confirmation is outstanding", async () => {
    seed();
    const p = await previewCleanup("m-1", "delete");
    expect(p?.ready).toBe(true);
  });

  test("ready=false when a real gate fails", async () => {
    seed({ targetPreexisted: true });
    const p = await previewCleanup("m-1", "delete");
    expect(p?.ready).toBe(false);
  });

  test("returns null for an unknown migration", async () => {
    expect(await previewCleanup("nope", "delete")).toBeNull();
  });
});
