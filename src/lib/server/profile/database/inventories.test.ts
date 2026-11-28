import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import type {
  BitbucketProfileEnrichment,
  ProfileNumericMetric,
  SourceNamespaceInventory,
} from "$lib/source/types";
import {
  getBitbucketActivityPage,
  getBitbucketLfsReportRows,
  getBitbucketLfsTracking,
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
        jobArtifactsSizeBytes: unavailable,
        pipelineArtifactsSizeBytes: unavailable,
        snippetsSizeBytes: unavailable,
        containerRegistrySizeBytes: unavailable,
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
  test("round-trips GitLab project statistics and preserves unknown storage in the rollup", () => {
    createRun();
    const base = inventory().projects[0]!;
    const projects = [
      {
        ...base,
        jobArtifactsSizeBytes: { kind: "exact", value: 1024 } as const,
        pipelineArtifactsSizeBytes: { kind: "exact", value: 0 } as const,
        containerRegistrySizeBytes: { kind: "unavailable", reason: "forbidden" } as const,
        providerDetails: {
          provider: "gitlab",
          commitCount: { kind: "exact", value: 17 },
        } as const,
      },
      { ...base, sourceId: "2", path: "platform/worker" },
    ];
    saveProfileInventory("run", inventory({ projectCount: { kind: "exact", value: 2 }, projects }));

    expect(getProfileInventory("run")?.projects).toEqual(projects);
    expect(getProfileInventorySummary("run")?.storage).toMatchObject({
      jobArtifactsSizeBytes: { kind: "at-least", value: 1024 },
      pipelineArtifactsSizeBytes: { kind: "at-least", value: 0 },
      snippetsSizeBytes: unavailable,
      containerRegistrySizeBytes: { kind: "unavailable", reason: "forbidden" },
    });
  });

  test("counts LFS rules across captured Bitbucket repositories, excluding unavailable checks", () => {
    const provider = "bitbucket-server";
    const sourceApiUrl = "https://bb.example.com/rest/api/1.0";
    createProfileRun({ id: "bb", org: "PC", sourceProvider: provider, sourceApiUrl });
    const base = inventory().projects[0]!;
    const states = ["none", undefined, "unknown", "found"] as const;
    saveProfileInventory("bb", {
      version: 1,
      provider,
      sourceApiUrl,
      namespace: "PC",
      projectCount: { kind: "exact", value: states.length },
      projects: states.map((state, i) => ({
        ...base,
        provider,
        sourceId: String(i),
        path: `PC/repo-${i}`,
        ...(state ? { providerDetails: { provider, rootLfsRules: state } } : {}),
      })),
    });
    expect(getBitbucketLfsTracking("bb")).toEqual({ checked: 2, found: 1, example: "PC/repo-3" });
    expect(getBitbucketLfsReportRows("bb")).toEqual(
      states.map((state, i) => ({
        repository: `PC/repo-${i}`,
        defaultBranch: "main",
        rootLfsRules: state ?? "unknown",
      })),
    );
  });
  test("pages Bitbucket activity with inventory-wide coverage and keeps uncollected and unavailable observations", () => {
    const provider = "bitbucket-server";
    const sourceApiUrl = "https://bb.example.com/rest/api/1.0";
    const namespace = "PC";
    createProfileRun({ id: "bb", org: namespace, sourceProvider: provider, sourceApiUrl });
    const base = inventory().projects[0];
    if (!base) throw new Error("missing fixture");
    const projects = Array.from({ length: 11 }, (_, i) => ({
      ...base,
      provider: "bitbucket-server" as const,
      sourceId: String(i),
      path: `PC/repo-${i}`,
    }));
    const metric: ProfileNumericMetric = {
      provider,
      endpointFamily: "repository-pull-requests",
      collectedAt: new Date(0).toISOString(),
      observation: { kind: "exact", value: 2, basis: "enumerated", scope: "visible" },
    };
    const metrics = {
      commits: metric,
      pullRequests: metric,
      branches: metric,
      tags: metric,
      forks: metric,
    };
    const review = {
      open: 2,
      merged: 0,
      declined: 0,
      oldestOpenCreatedAt: null,
      latestUpdatedAt: null,
    };
    const enrichment: BitbucketProfileEnrichment = {
      version: 2,
      provider,
      sourceApiUrl,
      namespace,
      projects: projects.map(({ path, sourceId }, i) => ({
        path,
        sourceId,
        metrics,
        activity: {
          defaultBranch: "main",
          tipCommittedAt: null,
          review: i === 10 ? review : null,
        },
      })),
    };
    settleProfileInventoryRun(
      "bb",
      {
        version: 1,
        provider,
        sourceApiUrl,
        namespace,
        projectCount: { kind: "exact", value: 11 },
        projects,
      },
      50,
      1,
      enrichment,
    );
    expect(getBitbucketActivityPage("bb", 1).rows[1]?.activity?.review).toBeNull();
    getDb().run("DELETE FROM profile_source_project_profiles WHERE run_id = ? AND path = ?", [
      "bb",
      "PC/repo-1",
    ]);
    expect(getBitbucketActivityPage("bb", 1).rows[1]?.activity).toBeNull();
    expect(getBitbucketActivityPage("bb", 99)).toMatchObject({
      coverage: { total: 11, collected: 10, covered: 1, open: 2, withOpen: 1 },
      pagination: { page: 2, totalPages: 2 },
      rows: [{ path: "PC/repo-10", activity: { review } }],
    });
    // A row outside the exact project must not affect download or coverage.
    getDb().run(
      "UPDATE profile_source_inventory_projects SET path='Other/private' WHERE path='PC/repo-0'",
    );
    expect(getBitbucketLfsReportRows("bb", namespace).map((r) => r.repository)).not.toContain(
      "Other/private",
    );
    expect(getBitbucketActivityPage("bb", 99, namespace)).toMatchObject({
      coverage: { total: 10, collected: 9 },
      pagination: { page: 1, totalPages: 1, total: 10 },
    });
  });
  test("round-trips GitLab and Bitbucket summaries whose metrics carry profile-only unavailable reasons", () => {
    const collectedAt = new Date(0).toISOString();
    const metric = (
      reason: "malformed" | "transient-failure" | "unsupported" | "not-reported" | "forbidden",
    ) => ({
      provider: "gitlab" as const,
      endpointFamily: "project-tags",
      collectedAt,
      observation: { kind: "unavailable" as const, reason, scope: "visible" },
    });
    const exact = {
      ...metric("malformed"),
      observation: { kind: "exact" as const, value: 1, basis: "reported" as const, scope: "v" },
    };
    createRun();
    const snapshot = inventory();
    settleProfileInventoryRun("run", snapshot, 1, 1, {
      version: 2,
      provider: "gitlab",
      sourceApiUrl: snapshot.sourceApiUrl,
      namespace: snapshot.namespace,
      projects: [
        {
          sourceId: "1",
          path: "platform/api",
          metrics: {
            issues: exact,
            mergeRequests: exact,
            commits: metric("unsupported"),
            branches: metric("transient-failure"),
            tags: metric("malformed"),
            releases: metric("malformed"),
            ciConfiguration: metric("unsupported"),
            protectedBranches: exact,
            inheritedProtectedBranches: metric("not-reported"),
            protectedTags: metric("forbidden"),
            projectWebhooks: { ...exact, eventCategories: ["push"] },
            groupWebhooks: { ...metric("unsupported"), eventCategories: [] },
          },
        },
      ],
    });
    expect(getProfileInventorySummary("run")?.metrics).toMatchObject({
      commits: { kind: "unavailable", reason: "unsupported" },
      branches: { kind: "unavailable", reason: "transient-failure" },
      tags: { kind: "unavailable", reason: "malformed" },
      releases: { kind: "unavailable", reason: "malformed" },
      inheritedProtectedBranches: { kind: "unavailable", reason: "not-reported" },
      protectedTags: { kind: "unavailable", reason: "forbidden" },
    });
    expect(getProfileInventorySummary("run")?.webhookEvents).toEqual({
      projectWebhooks: ["push"],
      groupWebhooks: [],
    });

    const provider = "bitbucket-server";
    const sourceApiUrl = "https://bb.example.com/rest/api/1.0";
    createProfileRun({ id: "bb", org: "PC", sourceProvider: provider, sourceApiUrl });
    const project = {
      ...snapshot.projects[0]!,
      provider: "bitbucket-server" as const,
      path: "PC/repo",
    };
    const bbMetric = { ...metric("malformed"), provider: "bitbucket-server" as const };
    settleProfileInventoryRun(
      "bb",
      { ...snapshot, provider, sourceApiUrl, namespace: "PC", projects: [project] },
      1,
      1,
      {
        version: 2,
        provider,
        sourceApiUrl,
        namespace: "PC",
        projects: [
          {
            sourceId: "1",
            path: "PC/repo",
            metrics: {
              commits: bbMetric,
              pullRequests: bbMetric,
              branches: bbMetric,
              tags: bbMetric,
              forks: bbMetric,
            },
            activity: { defaultBranch: "main", tipCommittedAt: null, review: null },
          },
        ],
      },
    );
    expect(getProfileInventorySummary("bb")?.metrics?.commits).toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  test("rejects an invalid stored summary without rewriting it", () => {
    createRun();
    saveProfileInventory("run", inventory(), 1);
    getDb().run("UPDATE profile_source_inventories SET summary = '{}' WHERE run_id = 'run'");
    expect(() => getProfileInventorySummary("run")).toThrow();
    expect(getDb().query("SELECT summary FROM profile_source_inventories").get()).toEqual({
      summary: "{}",
    });
  });

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
