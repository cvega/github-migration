/**
 * Tests for the pure cleanup eligibility evaluator. The refusal matrix is the
 * whole safety contract, so every vector has an explicit "refuses" case, plus
 * the happy path and the boundary conditions (window tolerance, mode/action
 * matrix, confirmation). No GitHub or DB — `evaluateCleanupEligibility` is pure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Migration } from "$lib/types";
import {
  type CleanupConfig,
  type CleanupGateStatus,
  type CleanupRequest,
  describeCleanupGates,
  effectiveCleanupMode,
  evaluateCleanupEligibility,
  type LiveRepoFacts,
  loadCleanupConfig,
  modePermits,
} from "./cleanup";

const NODE_ID = "R_kgDOabc123";
const START = "2026-06-01T00:00:00.000Z";
const END = "2026-06-01T00:30:00.000Z";

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
    completedAt: END,
    elapsedSeconds: 1800,
    authMode: "env-pat",
    requestOptions: null,
    targetPreexisted: false,
    targetRepoNodeId: NODE_ID,
    ...over,
  };
}

function live(over: Partial<LiveRepoFacts> = {}): LiveRepoFacts {
  return {
    nodeId: NODE_ID,
    owner: "acme-cloud",
    name: "widget",
    // Created mid-window.
    createdAt: "2026-06-01T00:10:00.000Z",
    ...over,
  };
}

function config(over: Partial<CleanupConfig> = {}): CleanupConfig {
  return { disabled: false, mode: "delete", hasAdminCredential: true, ...over };
}

function request(over: Partial<CleanupRequest> = {}): CleanupRequest {
  return { action: "delete", confirmation: "acme-cloud/widget", ...over };
}

function evalWith(parts: {
  migration?: Partial<Migration>;
  live?: Partial<LiveRepoFacts>;
  config?: Partial<CleanupConfig>;
  request?: Partial<CleanupRequest>;
}) {
  return evaluateCleanupEligibility({
    migration: migration(parts.migration),
    live: live(parts.live),
    config: config(parts.config),
    request: request(parts.request),
  });
}

describe("modePermits", () => {
  test("off permits nothing", () => {
    expect(modePermits("off", "rename")).toBe(false);
    expect(modePermits("off", "delete")).toBe(false);
  });
  test("rename permits only rename", () => {
    expect(modePermits("rename", "rename")).toBe(true);
    expect(modePermits("rename", "delete")).toBe(false);
  });
  test("delete permits both", () => {
    expect(modePermits("delete", "rename")).toBe(true);
    expect(modePermits("delete", "delete")).toBe(true);
  });
});

describe("evaluateCleanupEligibility — happy path", () => {
  test("all vectors pass → eligible", () => {
    expect(evalWith({})).toEqual({ eligible: true });
  });

  test("rename action under rename mode → eligible", () => {
    const r = evalWith({
      config: { mode: "rename" },
      request: { action: "rename" },
    });
    expect(r).toEqual({ eligible: true });
  });
});

describe("effectiveCleanupMode", () => {
  test("returns the configured mode when enabled with a credential", () => {
    expect(effectiveCleanupMode(config({ mode: "rename" }))).toBe("rename");
    expect(effectiveCleanupMode(config({ mode: "delete" }))).toBe("delete");
  });

  test("forces off when the kill switch is set", () => {
    expect(effectiveCleanupMode(config({ mode: "delete", disabled: true }))).toBe("off");
  });

  test("forces off when no admin credential is configured", () => {
    expect(effectiveCleanupMode(config({ mode: "delete", hasAdminCredential: false }))).toBe("off");
  });
});

describe("evaluateCleanupEligibility — refusal matrix (one per vector)", () => {
  test("1. kill switch refuses even with everything else valid", () => {
    const r = evalWith({ config: { disabled: true } });
    expect(r).toMatchObject({ eligible: false, reason: "globally-disabled" });
  });

  test("kill switch wins over an otherwise-permitted action", () => {
    const r = evalWith({ config: { disabled: true, mode: "delete" } });
    expect(r).toMatchObject({ eligible: false, reason: "globally-disabled" });
  });

  test("2. mode 'rename' refuses a delete action", () => {
    const r = evalWith({ config: { mode: "rename" }, request: { action: "delete" } });
    expect(r).toMatchObject({ eligible: false, reason: "mode-disallows-action" });
  });

  test("2. mode 'off' refuses a rename action", () => {
    const r = evalWith({ config: { mode: "off" }, request: { action: "rename" } });
    expect(r).toMatchObject({ eligible: false, reason: "mode-disallows-action" });
  });

  test("3. missing admin credential refuses", () => {
    const r = evalWith({ config: { hasAdminCredential: false } });
    expect(r).toMatchObject({ eligible: false, reason: "no-admin-credential" });
  });

  test("4. a succeeded migration is never eligible", () => {
    const r = evalWith({ migration: { state: "succeeded" } });
    expect(r).toMatchObject({ eligible: false, reason: "migration-not-terminal" });
  });

  test("4. a running migration is not eligible", () => {
    const r = evalWith({ migration: { state: "running" } });
    expect(r).toMatchObject({ eligible: false, reason: "migration-not-terminal" });
  });

  test("5. a pre-existing target is refused", () => {
    const r = evalWith({ migration: { targetPreexisted: true } });
    expect(r).toMatchObject({ eligible: false, reason: "target-preexisted" });
  });

  test("5. unknown provenance (null) is refused", () => {
    const r = evalWith({ migration: { targetPreexisted: null } });
    expect(r).toMatchObject({ eligible: false, reason: "target-preexisted" });
  });

  test("6. no recorded node_id is refused", () => {
    const r = evalWith({ migration: { targetRepoNodeId: null } });
    expect(r).toMatchObject({ eligible: false, reason: "no-recorded-node-id" });
  });

  test("7. node_id mismatch (delete+recreate) is refused", () => {
    const r = evalWith({ live: { nodeId: "R_kgDOdifferent" } });
    expect(r).toMatchObject({ eligible: false, reason: "node-id-mismatch" });
  });

  test("8. owner/name drift is refused", () => {
    const r = evalWith({ live: { name: "widget-renamed" } });
    expect(r).toMatchObject({ eligible: false, reason: "owner-name-mismatch" });
  });

  test("9. created before the window is refused", () => {
    const r = evalWith({ live: { createdAt: "2025-01-01T00:00:00.000Z" } });
    expect(r).toMatchObject({ eligible: false, reason: "created-outside-window" });
  });

  test("9. created after the window is refused", () => {
    const r = evalWith({ live: { createdAt: "2026-07-01T00:00:00.000Z" } });
    expect(r).toMatchObject({ eligible: false, reason: "created-outside-window" });
  });

  test("9. unparseable createdAt is refused", () => {
    const r = evalWith({ live: { createdAt: "not-a-date" } });
    expect(r).toMatchObject({ eligible: false, reason: "created-outside-window" });
  });

  test("10. wrong confirmation text is refused", () => {
    const r = evalWith({ request: { confirmation: "acme-cloud/wrong" } });
    expect(r).toMatchObject({ eligible: false, reason: "confirmation-mismatch" });
  });
});

describe("evaluateCleanupEligibility — window tolerance boundaries", () => {
  test("created slightly before start (within tolerance) is allowed", () => {
    // 5 min before start, tolerance is 10 min.
    const r = evalWith({ live: { createdAt: "2026-05-31T23:55:00.000Z" } });
    expect(r).toEqual({ eligible: true });
  });

  test("created slightly after completion (within tolerance) is allowed", () => {
    // 5 min after end, tolerance is 10 min.
    const r = evalWith({ live: { createdAt: "2026-06-01T00:35:00.000Z" } });
    expect(r).toEqual({ eligible: true });
  });

  test("uses now() as the window end when completedAt is null", () => {
    const r = evaluateCleanupEligibility({
      migration: migration({ completedAt: null, startedAt: new Date().toISOString() }),
      live: live({ createdAt: new Date().toISOString() }),
      config: config(),
      request: request(),
    });
    expect(r).toEqual({ eligible: true });
  });
});

describe("evaluateCleanupEligibility — vector ordering", () => {
  test("kill switch is reported before any other failing vector", () => {
    // Everything is also wrong, but disabled must win for a deterministic reason.
    const r = evaluateCleanupEligibility({
      migration: migration({ state: "succeeded", targetPreexisted: true, targetRepoNodeId: null }),
      live: live({ nodeId: "R_x", owner: "evil", name: "repo", createdAt: "1999-01-01T00:00:00Z" }),
      config: config({ disabled: true, mode: "off", hasAdminCredential: false }),
      request: request({ confirmation: "nope" }),
    });
    expect(r).toMatchObject({ eligible: false, reason: "globally-disabled" });
  });
});

describe("describeCleanupGates", () => {
  function describeWith(parts: {
    migration?: Partial<Migration>;
    live?: Partial<LiveRepoFacts>;
    config?: Partial<CleanupConfig>;
    request?: Partial<CleanupRequest>;
  }): CleanupGateStatus[] {
    return describeCleanupGates({
      migration: migration(parts.migration),
      live: live(parts.live),
      config: config(parts.config),
      request: request(parts.request),
    });
  }

  test("reports all 10 gates", () => {
    expect(describeWith({})).toHaveLength(10);
  });

  test("every gate passes on the happy path", () => {
    const gates = describeWith({});
    expect(gates.every((g) => g.passed)).toBe(true);
  });

  test("each gate has a non-empty label and detail", () => {
    for (const g of describeWith({})) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.detail.length).toBeGreaterThan(0);
    }
  });

  test("reports multiple simultaneous failures (not just the first)", () => {
    const gates = describeWith({
      config: { hasAdminCredential: false },
      migration: { targetPreexisted: true },
      request: { confirmation: "wrong" },
    });
    const failed = gates.filter((g) => !g.passed).map((g) => g.reason);
    expect(failed).toContain("no-admin-credential");
    expect(failed).toContain("target-preexisted");
    expect(failed).toContain("confirmation-mismatch");
  });

  test("an empty confirmation surfaces the confirmation gate as failing with guidance", () => {
    const gates = describeWith({ request: { confirmation: "" } });
    const confirm = gates.find((g) => g.reason === "confirmation-mismatch");
    expect(confirm?.passed).toBe(false);
    expect(confirm?.detail).toContain("acme-cloud/widget");
  });

  test("gate order matches the enforcement order (kill switch first, confirmation last)", () => {
    const reasons = describeWith({}).map((g) => g.reason);
    expect(reasons[0]).toBe("globally-disabled");
    expect(reasons[reasons.length - 1]).toBe("confirmation-mismatch");
  });
});

describe("loadCleanupConfig", () => {
  const KEYS = ["TARGET_CLEANUP_DISABLED", "TARGET_CLEANUP", "GH_TARGET_ADMIN_PAT"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("safe defaults: disabled flag off, mode off, no credential", () => {
    expect(loadCleanupConfig()).toEqual({
      disabled: false,
      mode: "off",
      hasAdminCredential: false,
    });
  });

  test("reads mode rename/delete; anything else is off", () => {
    process.env.TARGET_CLEANUP = "rename";
    expect(loadCleanupConfig().mode).toBe("rename");
    process.env.TARGET_CLEANUP = "delete";
    expect(loadCleanupConfig().mode).toBe("delete");
    process.env.TARGET_CLEANUP = "yes-please";
    expect(loadCleanupConfig().mode).toBe("off");
  });

  test("kill switch parses 'true' and '1'", () => {
    process.env.TARGET_CLEANUP_DISABLED = "true";
    expect(loadCleanupConfig().disabled).toBe(true);
    process.env.TARGET_CLEANUP_DISABLED = "1";
    expect(loadCleanupConfig().disabled).toBe(true);
    process.env.TARGET_CLEANUP_DISABLED = "false";
    expect(loadCleanupConfig().disabled).toBe(false);
  });

  test("detects the admin credential when present", () => {
    expect(loadCleanupConfig().hasAdminCredential).toBe(false);
    process.env.GH_TARGET_ADMIN_PAT = "ghp_admin";
    expect(loadCleanupConfig().hasAdminCredential).toBe(true);
  });
});
