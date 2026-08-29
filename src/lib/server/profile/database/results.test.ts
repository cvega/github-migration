import { describe, expect, test } from "bun:test";
import { buildProfileDetailRollup } from "../analysis/rollup";
import type { RepoSignals } from "../types";
import {
  parsePersistedCatalogMatches,
  parsePersistedOrgResources,
  parsePersistedProfileRollup,
  parsePersistedRepoSignals,
} from "./results";

function signals(): RepoSignals {
  return {
    name: "widget",
    nameWithOwner: "acme/widget",
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb: 100,
    hasWiki: false,
    hasIssues: true,
    hasProjects: false,
    hasDiscussions: false,
    hasPages: false,
    defaultBranch: "main",
    pushedAt: null,
    updatedAt: null,
    commitsCount: 10,
    discussionsCount: 0,
    projectsV2Count: 0,
    environmentsCount: 0,
    releaseAssetBytes: 0,
    stargazerCount: 0,
    watcherCount: 0,
    forkCount: 0,
    rulesetCount: 0,
    branchProtectionRuleCount: 0,
    branchProtectionRulesUsingUnmigratedFeatures: 0,
    packagesCount: 0,
    usesLfs: false,
    workflowFileCount: 0,
    webhooksCount: 0,
    hasCodeScanningAlerts: false,
    collaboratorsCount: 0,
    tagProtectionCount: 0,
    issuesCount: 0,
    pullRequestsCount: 0,
    branchesCount: 1,
    tagsCount: 0,
    releasesCount: 0,
  };
}

describe("persisted profile results", () => {
  test("fills missing legacy organization resources with zero", () => {
    expect(parsePersistedOrgResources(JSON.stringify({ teams: 3 }))).toEqual({
      actionsSecrets: 0,
      actionsVariables: 0,
      dependabotSecrets: 0,
      codespacesSecrets: 0,
      selfHostedRunners: 0,
      customProperties: 0,
      teams: 3,
      appInstallations: 0,
    });
  });

  test("parses complete signals and normalizes legacy catalog matches", () => {
    expect(parsePersistedRepoSignals(JSON.stringify(signals()))).toEqual(signals());
    expect(
      parsePersistedCatalogMatches(
        JSON.stringify([{ considerationId: "discussions", evidence: "3 discussions" }]),
      ),
    ).toEqual([{ catalogEntryId: "discussions", evidence: "3 discussions" }]);
    expect(() => parsePersistedOrgResources(JSON.stringify({ teams: "3" }))).toThrow();
  });

  test("round-trips valid rollups and rejects malformed optional cache data", () => {
    const rollup = buildProfileDetailRollup([]);
    expect(parsePersistedProfileRollup(JSON.stringify(rollup))).toEqual(rollup);
    expect(parsePersistedProfileRollup("not-json")).toBeNull();
    expect(parsePersistedProfileRollup(JSON.stringify({ scale: {} }))).toBeNull();
  });
});
