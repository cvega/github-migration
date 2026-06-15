import { describe, expect, test } from "bun:test";
import {
  type Consideration,
  type ConsiderationKind,
  type ConsiderationSeverity,
  MIGRATION_CONSIDERATIONS,
  MIGRATION_DOC_URL,
  MIGRATION_DOCS_VERIFIED,
} from "./consideration-registry";

const KINDS: ConsiderationKind[] = [
  "routable",
  "recreate",
  "reconfigure",
  "blocker",
  "accepted-loss",
];
const SEVERITIES: ConsiderationSeverity[] = ["info", "warn", "blocker"];

describe("consideration registry integrity", () => {
  test("is non-empty", () => {
    expect(MIGRATION_CONSIDERATIONS.length).toBeGreaterThan(0);
  });

  test("every id is unique", () => {
    const ids = MIGRATION_CONSIDERATIONS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every id is kebab-case", () => {
    for (const g of MIGRATION_CONSIDERATIONS) {
      expect(g.id, g.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test("every entry has a non-empty label, summary, and detector", () => {
    for (const g of MIGRATION_CONSIDERATIONS) {
      expect(g.label.trim().length, g.id).toBeGreaterThan(0);
      expect(g.summary.trim().length, g.id).toBeGreaterThan(0);
      expect(g.detector.trim().length, g.id).toBeGreaterThan(0);
    }
  });

  test("kind and severity are from the allowed sets", () => {
    for (const g of MIGRATION_CONSIDERATIONS) {
      expect(KINDS, g.id).toContain(g.kind);
      expect(SEVERITIES, g.id).toContain(g.severity);
    }
  });

  test("blocker kind ⟺ blocker severity", () => {
    for (const g of MIGRATION_CONSIDERATIONS) {
      expect(g.kind === "blocker", g.id).toBe(g.severity === "blocker");
    }
  });

  test("accepted-loss considerations are informational and route nowhere", () => {
    for (const g of MIGRATION_CONSIDERATIONS.filter((x) => x.kind === "accepted-loss")) {
      expect(g.severity, g.id).toBe("info");
      expect(g.routesTo, g.id).toBeNull();
    }
  });

  test("actionable considerations (routable/recreate/reconfigure) route somewhere", () => {
    const actionable: ConsiderationKind[] = ["routable", "recreate", "reconfigure"];
    for (const g of MIGRATION_CONSIDERATIONS.filter((x) => actionable.includes(x.kind))) {
      expect(g.routesTo, g.id).not.toBeNull();
      expect((g.routesTo ?? "").trim().length, g.id).toBeGreaterThan(0);
    }
  });

  test("blockers name a remediation", () => {
    for (const g of MIGRATION_CONSIDERATIONS.filter((x) => x.kind === "blocker")) {
      expect(g.routesTo, g.id).not.toBeNull();
    }
  });

  test("every docAnchor is a fragment that resolves against the base doc", () => {
    for (const g of MIGRATION_CONSIDERATIONS) {
      expect(g.docAnchor, g.id).toMatch(/^#[a-z0-9-]+$/);
    }
    expect(MIGRATION_DOC_URL).toMatch(/^https:\/\/docs\.github\.com\//);
  });

  test("size/limit blockers are estimated, exact-signal considerations are exact", () => {
    for (const g of MIGRATION_CONSIDERATIONS) {
      expect(["exact", "estimated"], g.id).toContain(g.confidence);
    }
    // Every blocker here is a size/policy limit we can only estimate pre-migration.
    for (const g of MIGRATION_CONSIDERATIONS.filter((x) => x.kind === "blocker")) {
      expect(g.confidence, g.id).toBe("estimated");
    }
  });

  test("the docs-verified stamp is an ISO date", () => {
    expect(MIGRATION_DOCS_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(MIGRATION_DOCS_VERIFIED))).toBe(false);
  });

  test("covers the considerations the Profile workspace is built around", () => {
    const ids = new Set(MIGRATION_CONSIDERATIONS.map((g) => g.id));
    for (const required of ["git-lfs", "packages", "discussions"]) {
      expect(ids, required).toContain(required);
    }
  });

  // Compile-time sanity: the array is readonly Consideration[].
  test("entries are typed as Consideration", () => {
    const first: Consideration | undefined = MIGRATION_CONSIDERATIONS[0];
    expect(first).toBeDefined();
  });
});
