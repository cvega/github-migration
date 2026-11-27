import { describe, expect, test } from "bun:test";
import type { RepoSignals, StoredCatalogMatch, StoredRepoProfile } from "../types";
import { buildPreparationSummary } from "./plan";

const STUB_SIGNALS = { releasesCount: 0, branchProtectionRuleCount: 0 } as RepoSignals;

function match(catalogEntryId: string): StoredCatalogMatch {
  return { catalogEntryId, evidence: "x" };
}

function repo(overrides: {
  blockers?: number;
  warnings?: number;
  matches?: StoredCatalogMatch[];
}): StoredRepoProfile {
  return {
    nameWithOwner: "acme/widget",
    signals: STUB_SIGNALS,
    blockers: overrides.blockers ?? 0,
    warnings: overrides.warnings ?? 0,
    infos: 0,
    catalogMatches: overrides.matches ?? [],
  };
}

describe("buildPreparationSummary", () => {
  test("orders catalog matches by severity then reach", () => {
    const summary = buildPreparationSummary([
      repo({ warnings: 1, matches: [match("discussions")] }),
      repo({
        blockers: 1,
        warnings: 1,
        matches: [match("discussions"), match("git-archive-size-limit")],
      }),
    ]);
    expect(
      summary.items.map(({ catalogEntryId, affectedRepos }) => [catalogEntryId, affectedRepos]),
    ).toEqual([
      ["git-archive-size-limit", 1],
      ["discussions", 2],
    ]);
  });

  test("tallies blocker, warning, and clean repositories independently", () => {
    const summary = buildPreparationSummary([
      repo({ blockers: 2, warnings: 1 }),
      repo({ warnings: 1 }),
      repo({}),
    ]);
    expect(summary).toMatchObject({ blockerRepos: 1, warnRepos: 2, cleanRepos: 1 });
  });

  test("preserves proven findings when readiness evidence is incomplete", () => {
    const incomplete = { ...STUB_SIGNALS, releaseAssetScanComplete: false };
    expect(
      buildPreparationSummary([
        {
          ...repo({ blockers: 1, warnings: 1, matches: [match("git-archive-size-limit")] }),
          signals: incomplete,
        },
        { ...repo({}), signals: incomplete },
      ]),
    ).toMatchObject({
      items: [{ catalogEntryId: "git-archive-size-limit", affectedRepos: 1 }],
      blockerRepos: 1,
      warnRepos: 1,
      cleanRepos: 0,
      incompleteRepos: 2,
    });
  });

  test("reports unevaluated coverage without duplicating detected or migration-wide facts", () => {
    const summary = buildPreparationSummary([]);
    const uncrawled = summary.notYetCrawled.map(({ catalogEntryId }) => catalogEntryId);
    const alwaysLost = summary.alwaysLost.map(({ catalogEntryId }) => catalogEntryId);
    expect(uncrawled).toContain("commit-size-limit");
    expect(uncrawled).not.toContain("discussions");
    expect(uncrawled).not.toContain("actions-secrets");
    expect(alwaysLost).toContain("mannequins");
    expect(alwaysLost).toContain("audit-log");
  });

  test("ignores stale catalog entry identifiers", () => {
    expect(
      buildPreparationSummary([repo({ warnings: 1, matches: [match("removed-id")] })]).items,
    ).toEqual([]);
  });
});
