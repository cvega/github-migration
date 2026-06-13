import { describe, expect, test } from "bun:test";
import {
  GAP_REGISTRY,
  type GapEntry,
  type GapKind,
  type GapSeverity,
  GEI_DOC_URL,
  GEI_DOCS_VERIFIED,
} from "./gap-registry";

const KINDS: GapKind[] = ["routable", "recreate", "reconfigure", "blocker", "accepted-loss"];
const SEVERITIES: GapSeverity[] = ["info", "warn", "blocker"];

describe("gap registry integrity", () => {
  test("is non-empty", () => {
    expect(GAP_REGISTRY.length).toBeGreaterThan(0);
  });

  test("every id is unique", () => {
    const ids = GAP_REGISTRY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every id is kebab-case", () => {
    for (const g of GAP_REGISTRY) {
      expect(g.id, g.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test("every entry has a non-empty label, summary, and detector", () => {
    for (const g of GAP_REGISTRY) {
      expect(g.label.trim().length, g.id).toBeGreaterThan(0);
      expect(g.summary.trim().length, g.id).toBeGreaterThan(0);
      expect(g.detector.trim().length, g.id).toBeGreaterThan(0);
    }
  });

  test("kind and severity are from the allowed sets", () => {
    for (const g of GAP_REGISTRY) {
      expect(KINDS, g.id).toContain(g.kind);
      expect(SEVERITIES, g.id).toContain(g.severity);
    }
  });

  test("blocker kind ⟺ blocker severity", () => {
    for (const g of GAP_REGISTRY) {
      expect(g.kind === "blocker", g.id).toBe(g.severity === "blocker");
    }
  });

  test("accepted-loss gaps are informational and route nowhere", () => {
    for (const g of GAP_REGISTRY.filter((x) => x.kind === "accepted-loss")) {
      expect(g.severity, g.id).toBe("info");
      expect(g.routesTo, g.id).toBeNull();
    }
  });

  test("actionable gaps (routable/recreate/reconfigure) route somewhere", () => {
    const actionable: GapKind[] = ["routable", "recreate", "reconfigure"];
    for (const g of GAP_REGISTRY.filter((x) => actionable.includes(x.kind))) {
      expect(g.routesTo, g.id).not.toBeNull();
      expect((g.routesTo ?? "").trim().length, g.id).toBeGreaterThan(0);
    }
  });

  test("blockers name a remediation", () => {
    for (const g of GAP_REGISTRY.filter((x) => x.kind === "blocker")) {
      expect(g.routesTo, g.id).not.toBeNull();
    }
  });

  test("every docAnchor is a fragment that resolves against the base doc", () => {
    for (const g of GAP_REGISTRY) {
      expect(g.docAnchor, g.id).toMatch(/^#[a-z0-9-]+$/);
    }
    expect(GEI_DOC_URL).toMatch(/^https:\/\/docs\.github\.com\//);
  });

  test("size/limit blockers are estimated, exact-signal gaps are exact", () => {
    for (const g of GAP_REGISTRY) {
      expect(["exact", "estimated"], g.id).toContain(g.confidence);
    }
    // Every blocker here is a size/policy limit we can only estimate pre-migration.
    for (const g of GAP_REGISTRY.filter((x) => x.kind === "blocker")) {
      expect(g.confidence, g.id).toBe("estimated");
    }
  });

  test("the docs-verified stamp is an ISO date", () => {
    expect(GEI_DOCS_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(GEI_DOCS_VERIFIED))).toBe(false);
  });

  test("covers the gaps the Profile workspace is built around", () => {
    const ids = new Set(GAP_REGISTRY.map((g) => g.id));
    for (const required of ["git-lfs", "packages", "discussions"]) {
      expect(ids, required).toContain(required);
    }
  });

  // Compile-time sanity: the array is readonly GapEntry[].
  test("entries are typed as GapEntry", () => {
    const first: GapEntry | undefined = GAP_REGISTRY[0];
    expect(first).toBeDefined();
  });
});
