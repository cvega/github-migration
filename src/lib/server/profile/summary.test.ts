/**
 * Tests for the org-level preparation summary. Pure rollup over persisted
 * per-repo profiles: it reads each repo's severity counts and applying
 * considerations (not its raw signals), so the fixtures stub signals and focus
 * on blockers/warnings and the applying-consideration ids.
 */
import { describe, expect, test } from "bun:test";
import { buildPreparationSummary } from "./summary";
import type { RepoSignals, StoredFinding, StoredRepoProfile } from "./types";

// The summary never reads raw signals, so a stub double keeps fixtures focused.
const STUB_SIGNALS = {} as unknown as RepoSignals;

function repo(over: {
  nameWithOwner?: string;
  blockers?: number;
  warnings?: number;
  infos?: number;
  applying?: StoredFinding[];
}): StoredRepoProfile {
  return {
    nameWithOwner: over.nameWithOwner ?? "o/r",
    signals: STUB_SIGNALS,
    blockers: over.blockers ?? 0,
    warnings: over.warnings ?? 0,
    infos: over.infos ?? 0,
    applyingConsiderations: over.applying ?? [],
  };
}

function finding(considerationId: string): StoredFinding {
  return { considerationId, evidence: "x" };
}

describe("buildPreparationSummary", () => {
  test("rolls applying considerations up by id with affected-repo counts", () => {
    const summary = buildPreparationSummary([
      repo({ warnings: 1, applying: [finding("discussions")] }),
      repo({
        blockers: 1,
        warnings: 1,
        applying: [finding("discussions"), finding("git-archive-size-limit")],
      }),
    ]);

    // Blocker sorts before warn; discussions reaches two repos.
    expect(summary.items.map((i) => [i.considerationId, i.affectedRepos])).toEqual([
      ["git-archive-size-limit", 1],
      ["discussions", 2],
    ]);
    // Registry metadata is joined in (the external-tool remediation).
    const discussions = summary.items.find((i) => i.considerationId === "discussions");
    expect(discussions?.severity).toBe("warn");
    expect(discussions?.routesTo).toBe("Discussions migration tooling");
  });

  test("tallies blocker, warn, and clean repos", () => {
    const summary = buildPreparationSummary([
      repo({ blockers: 2, warnings: 1 }),
      repo({ warnings: 1 }),
      repo({}),
    ]);
    expect(summary.blockerRepos).toBe(1);
    expect(summary.warnRepos).toBe(2);
    expect(summary.cleanRepos).toBe(1);
  });

  test("lists not-yet-crawled considerations, excluding detected ones", () => {
    const { notYetCrawled } = buildPreparationSummary([]);
    const ids = notYetCrawled.map((c) => c.considerationId);
    expect(ids).toContain("webhooks"); // signal not gathered yet
    expect(ids).not.toContain("discussions"); // detected
    expect(ids).not.toContain("packages"); // detected
    expect(ids).not.toContain("git-lfs"); // detected
  });

  test("ignores a stale considerationId that is no longer in the registry", () => {
    const summary = buildPreparationSummary([
      repo({ warnings: 1, applying: [finding("not-a-real-id")] }),
    ]);
    expect(summary.items).toHaveLength(0);
  });
});
