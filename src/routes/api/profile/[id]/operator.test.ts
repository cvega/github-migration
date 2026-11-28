import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { assignGrant, listGrants } from "$lib/server/application/self-service/grants";
import * as jobs from "$lib/server/application/self-service/jobs";
import {
  countOwnProfileRuns,
  listOwnProfileRuns,
} from "$lib/server/application/self-service/profiles";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { settleProfileInventoryRun } from "$lib/server/profile/database/inventories";
import { createProfileRun } from "$lib/server/profile/database/runs";
import { DOMAIN_STORES } from "$lib/server/schemas";
import { gitLabMetricFixtures } from "$lib/source/gitlab-metrics/fixtures";
import type { GitLabProfileEnrichment, SourceProjectInventory } from "$lib/source/types";
import { GET, POST } from "./+server";

const grant = {
  sourceProvider: "gitlab" as const,
  sourceApiUrl: "https://gitlab.example/api/v4",
  namespace: "team/products",
  targetProfileId: "ghec",
  targetOrg: "landing",
  canMigrate: true,
};
const config = { GH_TARGET_ORG: "landing", GITLAB_SOURCE_API_URL: "https://gitlab.example" };
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, config);
  initStore(":memory:", [...DOMAIN_STORES]);
  for (const id of ["admin", "alice"])
    getDb().run(
      `INSERT INTO app_users(id,username,password_hash,role,created_at,updated_at) VALUES (?,?,'unused',?,'now','now')`,
      [id, id, id === "admin" ? "admin" : "operator"],
    );
  assignGrant("admin", "alice", grant);
});
afterEach(() => {
  closeStore();
  for (const key of Object.keys(config)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function snapshot(id: string, paths: string[], org = grant.namespace) {
  createProfileRun({
    id,
    org,
    sourceProvider: grant.sourceProvider,
    sourceApiUrl: grant.sourceApiUrl,
  });
  const observed = { kind: "exact" as const, value: 1 };
  const projects: SourceProjectInventory[] = paths.map((path, i) => ({
    provider: "gitlab",
    sourceId: String(i + 1),
    path,
    name: path.split("/").at(-1)!,
    visibility: "private",
    archived: false,
    defaultBranch: "main",
    lastActivityAt: null,
    repositorySizeBytes: observed,
    storageSizeBytes: observed,
    lfsObjectsSizeBytes: observed,
    packagesSizeBytes: observed,
    wikiSizeBytes: observed,
    uploadsSizeBytes: observed,
    jobArtifactsSizeBytes: observed,
    pipelineArtifactsSizeBytes: observed,
    snippetsSizeBytes: observed,
    containerRegistrySizeBytes: observed,
  }));
  const metric = {
    provider: "gitlab",
    endpointFamily: "project-issues",
    collectedAt: new Date(0).toISOString(),
    observation: { kind: "exact", value: 7, basis: "enumerated", scope: "visible" },
  } as const;
  const enrichment: GitLabProfileEnrichment = {
    provider: "gitlab",
    version: 2,
    sourceApiUrl: grant.sourceApiUrl,
    namespace: org,
    projects: projects.map(({ path, sourceId }) => ({
      path,
      sourceId,
      metrics: gitLabMetricFixtures({
        issues: metric,
        mergeRequests: metric,
        branches: metric,
        commits: metric,
        tags: metric,
        releases: metric,
        ciConfiguration: metric,
        protectedBranches: metric,
        inheritedProtectedBranches: metric,
        protectedTags: metric,
        projectWebhooks: { ...metric, eventCategories: [] },
        groupWebhooks: { ...metric, eventCategories: [] },
      }),
    })),
  };
  settleProfileInventoryRun(
    id,
    {
      version: 1,
      provider: "gitlab",
      sourceApiUrl: grant.sourceApiUrl,
      namespace: org,
      projectCount: { kind: "at-least", value: projects.length },
      projects,
    },
    777,
    1,
    enrichment,
  );
}

function event(id: string, view = "", body?: unknown) {
  const url = new URL(`https://app.example/api/profile/${id}?view=${view}`);
  return {
    params: { id },
    url,
    locals: { authEnabled: true, user: { id: "alice", role: "operator" } },
    request:
      body === undefined
        ? new Request(url)
        : new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
  } as Parameters<typeof GET>[0];
}

test("mixed subgroup inventory is scoped before aggregation, planning limits, and list pagination", async () => {
  const nested = `${grant.namespace}/private-subgroup`;
  snapshot("mixed", [
    ...Array.from({ length: 500 }, (_, i) => `${nested}/r${i}`),
    `${grant.namespace}/direct`,
  ]);
  snapshot("sibling", ["team/other/hidden"], "team/other");
  expect(countOwnProfileRuns("alice")).toBe(1);
  expect(countOwnProfileRuns("alice", "other")).toBe(0);
  expect(listOwnProfileRuns("alice", 1, 0)).toMatchObject([
    {
      id: "mixed",
      totalRepos: 1,
      profiledRepos: 1,
      inventoryProjectCount: { kind: "at-least", value: 1 },
      metrics: { commits: { value: 7 } },
    },
  ]);
  const detail = await (await GET(event("mixed"))).json();
  expect(detail.inventorySummary).toMatchObject({
    projectsCaptured: 1,
    visibility: { private: 1 },
    metrics: { issues: { value: 7 } },
    storage: { storageSizeBytes: { value: 1 } },
  });
  expect(detail).toMatchObject({ scale: null, composition: null, summary: null, estimate: null });
  expect(detail.planningRepos.map((r: { nameWithOwner: string }) => r.nameWithOwner)).toEqual([
    `${grant.namespace}/direct`,
  ]);
  expect(JSON.stringify(detail)).not.toContain("private-subgroup");
  for (const view of ["", "repos", "status", "activity", "lfs"])
    expect((await GET(event("sibling", view))).status).toBe(404);
  getDb().run("DELETE FROM self_service_grants");
  expect((await GET(event("mixed", "repos"))).status).toBe(404);
  expect(countOwnProfileRuns("alice")).toBe(0);
});

test("profile submission rejects destination overrides, missing paths, read-only and revoked grants", async () => {
  snapshot("mine", [`${grant.namespace}/direct`]);
  const submit = spyOn(jobs, "submitOwnBatch").mockReturnValue({
    batchId: "batch",
    jobIds: ["job"],
  });
  const grantId = listGrants("alice")[0]!.id;
  try {
    const response = await POST(event("mine", "", { repos: ["direct"], grantId }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "batch" });
    expect(submit).toHaveBeenCalledWith("alice", {
      grantId,
      repos: ["direct"],
    });
  } finally {
    submit.mockRestore();
  }
  for (const body of [
    { repos: ["direct"], targetOrg: "other" },
    { sourceProvider: "gitlab", repos: ["direct"] },
    { repos: ["missing"] },
    { repos: ["child/name"] },
  ]) {
    expect((await POST(event("mine", "", { ...body, grantId }))).status).toBe(400);
  }
  getDb().run("UPDATE self_service_grants SET can_migrate=0");
  expect((await POST(event("mine", "", { repos: ["direct"], grantId }))).status).toBe(403);
  getDb().run("DELETE FROM self_service_grants");
  expect((await POST(event("mine", "", { repos: ["direct"] }))).status).toBe(404);
});

test("report submissions reject ambiguous, cross-source and read-only choices before creating jobs", async () => {
  process.env.GH_TARGET_ORG = "landing,other";
  const other = { ...grant, targetOrg: "other" };
  assignGrant("admin", "alice", { ...other, canMigrate: false });
  assignGrant("admin", "alice", { ...other, namespace: "other-group" });
  snapshot("mine", [`${grant.namespace}/direct`]);
  const choices = listGrants("alice");
  for (const g of choices.filter((g) => g.targetOrg === "other"))
    expect((await POST(event("mine", "", { repos: ["direct"], grantId: g.id }))).status).toBe(403);
  expect((await POST(event("mine", "", { repos: ["direct"] }))).status).toBe(400);
  expect(getDb().query("SELECT count(*) n FROM migrations").get()).toEqual({ n: 0 });
});
