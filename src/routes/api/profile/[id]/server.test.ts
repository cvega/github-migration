import { beforeEach, describe, expect, test } from "bun:test";
import type { RepoSignals } from "$lib/profile/types";
import { initStore } from "$lib/server/core/db";
import { saveProfileInventory } from "$lib/server/profile/database/inventories";
import { recordRepoProfile } from "$lib/server/profile/database/repos";
import { createProfileRun } from "$lib/server/profile/database/runs";
import { DOMAIN_STORES } from "$lib/server/schemas";
import type { SourceNamespaceInventory } from "$lib/source/types";
import { GET } from "./+server";

beforeEach(() => {
  initStore(":memory:", [...DOMAIN_STORES]);
});

type GetArgs = Parameters<typeof GET>[0];

describe("GET /api/profile/[id]", () => {
  test("returns a compact GitLab summary with uncertainty and no full inventory", async () => {
    createProfileRun({
      id: "gitlab-detail",
      sourceProvider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      org: "platform/products",
    });
    const inventory: SourceNamespaceInventory = {
      version: 1,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform/products",
      projectCount: { kind: "at-least", value: 0 },
      projects: [],
    };
    saveProfileInventory("gitlab-detail", inventory);

    const response = await GET({
      params: { id: "gitlab-detail" },
      url: new URL("https://example.test/api/profile/gitlab-detail"),
    } as GetArgs);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.inventorySummary.projectCount).toEqual({ kind: "at-least", value: 0 });
    expect(body).not.toHaveProperty("inventory");
    expect(JSON.stringify(body)).not.toContain('"projects"');
  });

  test("returns only run status and inventory summary for status polling", async () => {
    createProfileRun({
      id: "gitlab-status",
      sourceProvider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      org: "platform/products",
    });

    const response = await GET({
      params: { id: "gitlab-status" },
      url: new URL("https://example.test/api/profile/gitlab-status?view=status"),
    } as GetArgs);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ run: expect.any(Object), inventorySummary: null });
    expect(body).not.toHaveProperty("repos");
    expect(body).not.toHaveProperty("summary");
  });

  test("returns a bounded, filtered repository page without profile aggregates", async () => {
    createProfileRun({
      id: "github-page",
      sourceApiUrl: "https://api.github.com",
      org: "acme",
    });
    const signals: RepoSignals = {
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
      commitsCount: 0,
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
      branchesCount: 0,
      tagsCount: 0,
      releasesCount: 0,
    };
    recordRepoProfile("github-page", signals, {
      nameWithOwner: "acme/widget",
      summary: {
        applies: 1,
        blockers: 1,
        warnings: 0,
        infos: 0,
        clear: 0,
        indeterminate: 0,
      },
      findings: [],
    });

    const response = await GET({
      params: { id: "github-page" },
      url: new URL(
        "https://example.test/api/profile/github-page?view=repos&page=1&search=widget&readiness=blockers",
      ),
    } as GetArgs);
    const body = await response.json();

    expect(body.repoPage).toEqual({ page: 1, totalPages: 1, total: 1, limit: 25 });
    expect(body.repos).toHaveLength(1);
    expect(body).not.toHaveProperty("scale");
    expect(body).not.toHaveProperty("planningRepos");
  });

  test("returns 404 for an unknown run", async () => {
    const response = await GET({
      params: { id: "missing" },
      url: new URL("https://example.test/api/profile/missing"),
    } as GetArgs);

    expect(response.status).toBe(404);
  });
});
