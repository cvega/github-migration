import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { insertEvent } from "$lib/server/migrate/database/events";
import { getMigration, insertMigration } from "$lib/server/migrate/database/migrations";
import { migrateStore } from "$lib/server/migrate/database/schema";
import { getRegisteredMigrationExecutor } from "$lib/server/migrate/executors/registry";
import { cancel, recoverOrphans, restart } from "$lib/server/migrate/manager";
import { resolveEffectiveSourceApiUrl } from "$lib/server/migrate/ports/source-runtime";
import { profileStore } from "$lib/server/profile/database/schema";
import type { SourceProvider } from "$lib/source-provider";
import {
  DELETE as cancelRoute,
  GET as readRoute,
} from "../../../../routes/api/migrate/[id]/+server";
import { GET as logRoute } from "../../../../routes/api/migrate/[id]/events/+server";
import { POST as restartRoute } from "../../../../routes/api/migrate/[id]/restart/+server";
import { POST as adminProfileBatch } from "../../../../routes/api/migrate/batches/+server";
import { POST as operatorProfileBatch } from "../../../../routes/api/profile/[id]/+server";
import { assignGrant, listGrants } from "./grants";
import {
  cancelOwnJob,
  configureOperatorJobPolicy,
  ownJobActions,
  restartOwnJob,
  submitOwnBatch,
} from "./jobs";
import { getVisibleDetail } from "./visible-events";
import { getVisibleJob, listVisibleJobs, visibleBatch, visibleDashboard } from "./visible-jobs";

const config = {
  GH_SOURCE_PAT: "source",
  GH_SOURCE_ORG: "SRC",
  GH_SOURCE_API_URL: "https://api.github.com",
  GH_TARGET_ORG: "dest,other",
  GH_TARGET_PAT: "target",
  GITLAB_SOURCE_NAMESPACE: "SRC",
  GITLAB_SOURCE_API_URL: "https://gitlab.example",
  GITLAB_SOURCE_PAT: "gitlab",
  BITBUCKET_SERVER_PROJECT_KEYS: "SRC",
  BITBUCKET_SERVER_URL: "https://bitbucket.example",
  BITBUCKET_SERVER_USERNAME: "user",
  BITBUCKET_SERVER_PASSWORD: "source",
  BITBUCKET_SERVER_SSH_USERNAME: "ssh",
  BITBUCKET_SERVER_SSH_PRIVATE_KEY: "-----BEGIN TEST KEY-----",
  BITBUCKET_SERVER_SSH_HOST_KEY_SHA256: "fake",
  ARCHIVE_DIR: "/archives",
  GHES_TARGET_ID: "enterprise",
  GHES_TARGET_ORG: "dest",
  GHES_TARGET_API_URL: "https://ghes.example",
  GHES_TARGET_ADMIN_USERNAME: "admin",
  GHES_TARGET_ADMIN_PAT: "ghes",
  GHES_TARGET_SSH_PRIVATE_KEY: "-----BEGIN TEST KEY-----",
  GHES_TARGET_SSH_HOST_KEY_SHA256: "fake",
  EXPORTER_ARCHIVE_VOLUME: "test",
  BBS_EXPORTER_IMAGE: "test",
};
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, config);
  initStore(":memory:", [authStore, profileStore, migrateStore]);
  for (const [id, role] of [
    ["alice", "operator"],
    ["bob", "operator"],
    ["admin", "admin"],
  ]) {
    getDb().run(
      `INSERT INTO app_users(id,username,password_hash,role,created_at,updated_at)
      VALUES (?,?,'unused',?,'now','now')`,
      [id!, id!, role!],
    );
  }
  configureOperatorJobPolicy();
});
afterEach(() => {
  mock.restore();
  closeStore();
  for (const key of Object.keys(config)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function fixture(sourceProvider: SourceProvider = "github", targetProfileId = "ghec") {
  const sourceApiUrl = resolveEffectiveSourceApiUrl({ sourceProvider });
  const grant = {
    sourceProvider,
    sourceApiUrl,
    namespace: "SRC",
    targetProfileId,
    targetOrg: "dest",
    canMigrate: true,
  };
  for (const user of ["alice", "bob"]) assignGrant("admin", user, grant);
  getDb().run(
    `INSERT INTO profile_runs(id,source_provider,source_api_url,org,state,started_at,completed_at)
    VALUES ('profile',?,?,'SRC','completed','2026-01-01','2026-01-02')`,
    [sourceProvider, sourceApiUrl],
  );
  if (sourceProvider === "github") {
    getDb().run(
      `INSERT INTO profile_repos(run_id,name_with_owner,created_at) VALUES ('profile','SRC/repo','now')`,
    );
  } else {
    getDb().run(
      `INSERT INTO profile_source_inventories(run_id,fetched_at) VALUES ('profile','now')`,
    );
    getDb().run(`INSERT INTO profile_source_inventory_projects(run_id,position,source_id,path,payload)
      VALUES ('profile',0,'1','SRC/repo','{}')`);
  }
  const executor = getRegisteredMigrationExecutor({
    sourceProvider,
    targetPlatform: targetProfileId === "ghec" ? "ghec" : "ghes",
  });
  const run = spyOn(executor, "run").mockImplementation(async ({ id }) => ({
    ...getMigration(id!)!,
    state: "failed",
    failureReason: "test worker result",
    completedAt: new Date().toISOString(),
  }));
  return {
    selection: { grantId: listGrants("alice")[0]!.id, repos: ["repo"] },
    grant,
    run,
    executor,
  };
}

test.each(["admin", "operator"] as const)(
  "%s cannot admit a partial batch with a flagged, unanalyzed repo",
  async (role) => {
    const { run, selection } = fixture();
    getDb().run(
      "INSERT INTO profile_repos(run_id,name_with_owner,warnings,created_at) VALUES ('profile','SRC/flagged',1,'now')",
    );
    const scoped = role === "operator";
    const body = scoped
      ? { grantId: selection.grantId, repos: ["repo", "flagged"] }
      : {
          profileRunId: "profile",
          repos: ["SRC/repo", "SRC/flagged"],
          targetProfileId: "ghec",
          targetOrg: "dest",
        };
    const response = await (scoped ? operatorProfileBatch : adminProfileBatch)({
      params: { id: "profile" },
      locals: { user: { id: scoped ? "alice" : "admin", role } },
      request: new Request("https://fixture.invalid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    } as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Repository 'SRC/flagged' requires successful Git analysis",
    });
    expect(getDb().query("SELECT count(*) AS n FROM migrations").get()).toEqual({ n: 0 });
    expect(run).not.toHaveBeenCalled();
  },
);

test.each([
  ["github", "ghec"],
  ["gitlab", "ghec"],
  ["bitbucket-server", "ghec"],
  ["bitbucket-server", "enterprise"],
] as const)(
  "dispatches and restarts %s -> %s using only the owned server route",
  async (source, target) => {
    const { selection, run, grant } = fixture(source, target);
    const {
      batchId,
      jobIds: [id],
    } = submitOwnBatch("alice", selection);
    await Bun.sleep(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({
      sourceProvider: source,
      sourceRepo: "SRC/repo",
      targetOrg: "dest",
      targetRepo: "repo",
      sourceApiUrl: grant.sourceApiUrl,
      targetProfileId: target,
    });
    expect(getMigration(id!)?.ownerUserId).toBe("alice");
    expect(ownJobActions("alice", id!).canRestart).toBe(true);
    expect(getVisibleJob("bob", id!)).toMatchObject({ id, batchId, state: "failed" });
    expect(ownJobActions("bob", id!).canRestart).toBe(false);
    expect(cancelOwnJob("bob", id!)).toBe(false);
    expect(() => restartOwnJob("bob", id!)).toThrow();
    restartOwnJob("alice", id!);
    await Bun.sleep(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(getVisibleDetail("alice", id!)?.events).toMatchObject([{ eventType: "restart" }]);
  },
);

test("late invalid selection rolls back the entire batch; rejects overrides and lookalikes", () => {
  const { selection, run } = fixture();
  for (const repos of [["repo", "missing"], ["repo", "REPO"], ["Repo"], ["../repo"], []]) {
    expect(() => submitOwnBatch("alice", { ...selection, repos })).toThrow();
  }
  for (const key of [
    "ownerUserId",
    "targetOrg",
    "sourceApiUrl",
    "targetProfileId",
    "sourceToken",
    "items",
    "options",
  ]) {
    expect(() => submitOwnBatch("alice", { ...selection, [key]: "override" })).toThrow();
  }
  expect(getDb().query("SELECT COUNT(*) AS n FROM migrations").get()).toEqual({ n: 0 });
  expect(getDb().query("SELECT COUNT(*) AS n FROM migration_batch_items").get()).toEqual({ n: 0 });
  expect(run).not.toHaveBeenCalled();
});

test("dispatch and restart use the chosen pair, never a sibling permission or another user's route", async () => {
  const { grant, run } = fixture();
  assignGrant("admin", "alice", { ...grant, targetOrg: "other" });
  const other = listGrants("alice").find((g) => g.targetOrg === "other")!;
  expect(() => submitOwnBatch("bob", { grantId: other.id, repos: ["repo"] })).toThrow();
  const {
    jobIds: [id],
  } = submitOwnBatch("alice", { grantId: other.id, repos: ["repo"] });
  await Bun.sleep(0);
  expect(run.mock.calls[0]![0]).toMatchObject({ targetOrg: "other", targetProfileId: "ghec" });
  expect(getVisibleJob("bob", id!)).toBeNull();
  expect(ownJobActions("alice", id!).canRestart).toBe(true);
  getDb().run("DELETE FROM self_service_grants WHERE id=?", [other.id]);
  expect(ownJobActions("alice", id!).canRestart).toBe(false);
  expect(() => restartOwnJob("alice", id!)).toThrow();
  expect(run).toHaveBeenCalledTimes(1);
});

test("authorized colleagues see progress but not provider diagnostics or signed log links", async () => {
  const { selection } = fixture();
  const {
    jobIds: [id],
  } = submitOwnBatch("alice", selection);
  await Bun.sleep(0);
  const base = {
    migrationId: id!,
    createdAt: "2026-01-02T00:00:00Z",
    phase: "IMPORTING_GIT" as const,
  };
  const diagnostic = "private-provider-detail";
  const current = {
    timestamp: base.createdAt,
    phase: base.phase,
    migrationState: diagnostic,
    failureReason: diagnostic,
    migrationLogUrl: diagnostic,
    warningsCount: 1,
    repoExists: true,
    countsAuthoritative: true,
    repoSize: 20,
    commits: 5,
    branches: 1,
    tags: 0,
    issues: 3,
    pullRequests: 2,
    releases: 0,
    elapsed: 8,
  };
  const progress = {
    current,
    previous: current,
    deltaCommits: 2,
    deltaBranches: 0,
    deltaTags: 0,
    deltaIssues: 1,
    deltaPRs: 0,
    deltaReleases: 0,
    deltaSize: 2,
    commitsPerMin: 1,
    issuesPerMin: 1,
  };
  insertEvent({ ...base, eventType: "snapshot", payload: { progress, sourceCounts: null } });
  insertEvent({
    ...base,
    eventType: "complete",
    payload: { progress, sourceCounts: null, elapsed: 8 },
  });
  insertEvent({ ...base, eventType: "failure", payload: { error: diagnostic } });
  insertEvent({ ...base, eventType: "milestone", payload: { message: diagnostic } });
  const events = getVisibleDetail("bob", id!)?.events;
  expect(events?.map((e) => e.eventType)).toEqual(["snapshot", "complete", "failure", "milestone"]);
  expect(events?.[0]?.payload).toMatchObject({
    progress: { current: { issues: 3 }, previous: { commits: 5 }, deltaIssues: 1 },
  });
  expect(JSON.stringify(events)).not.toContain(diagnostic);
});

test.each([
  ["revoked", "DELETE FROM self_service_grants WHERE user_id='alice'"],
  ["target changed", "UPDATE self_service_routes SET target_org='other'"],
  [
    "inventory replaced",
    `INSERT INTO profile_runs(id,source_provider,source_api_url,org,state,started_at,completed_at)
    VALUES ('new','github','https://api.github.com','SRC','completed','2026-02-01','2026-02-02')`,
  ],
  ["user disabled", "UPDATE app_users SET is_active=0 WHERE id='alice'"],
])("%s between queue claim and execution prevents dispatch and restart", async (_label, change) => {
  const { selection, run } = fixture();
  const {
    jobIds: [id],
  } = submitOwnBatch("alice", selection);
  getDb().run(change!);
  await Bun.sleep(0);
  expect(run).not.toHaveBeenCalled();
  expect(getMigration(id!)?.state).toBe("failed");
  expect(ownJobActions("alice", id!).canRestart).toBe(false);
  expect(!!getVisibleJob("alice", id!)).toBe(_label === "inventory replaced");
  expect(() => restart(id!, {})).toThrow(); // global restart cannot launder ownership
});

test("cancel and restart require ownership and migration permission; admins may stop revoked jobs", async () => {
  const { selection, run } = fixture();
  // Occupy the worker pool so the two jobs stay queued.
  for (let i = 0; i < 10; i++)
    getDb().run(
      `INSERT INTO migrations
    (id,source_api_url,source_org,source_repo,target_org,target_repo,state,started_at)
    VALUES (?,'https://api.github.com','SRC','a','dest','a','running','now')`,
      [`admin-${i}`],
    );
  const {
    jobIds: [a],
  } = submitOwnBatch("alice", selection);
  const {
    jobIds: [b],
  } = submitOwnBatch("alice", selection);
  expect(cancelOwnJob("bob", a!)).toBe(false);
  expect(cancelOwnJob("alice", a!)).toBe(true);
  expect(getMigration(a!)?.state).toBe("cancelled");
  getDb().run("UPDATE self_service_grants SET can_migrate=0 WHERE user_id='alice'");
  expect(() => submitOwnBatch("alice", selection)).toThrow();
  expect(() => restartOwnJob("alice", a!)).toThrow();
  expect(cancelOwnJob("alice", b!)).toBe(false);
  expect(cancel(b!)).toBe(true);
  expect(run).not.toHaveBeenCalled();
});

test("startup recovery quarantines an owned checkpoint after revocation", async () => {
  const { selection, executor } = fixture();
  const resume = spyOn(executor, "resume");
  const {
    jobIds: [id],
  } = submitOwnBatch("alice", selection);
  await Bun.sleep(0);
  getDb().run("UPDATE migrations SET state='running', github_migration_id='remote' WHERE id=?", [
    id!,
  ]);
  getDb().run("DELETE FROM self_service_grants WHERE user_id='alice'");
  recoverOrphans();
  await Bun.sleep(0);
  expect(resume).not.toHaveBeenCalled();
  expect(getMigration(id!)?.state).toBe("reconciliation_required");
});

test("current pairs, not ownership, bound search, logs, counts and mixed-batch pages", async () => {
  const { selection } = fixture();
  const {
    batchId,
    jobIds: [id],
  } = submitOwnBatch("alice", selection);
  await Bun.sleep(0);
  const base = getMigration(id!)!;
  const paging = { page: 1, limit: 10 };
  const admin = {
    ...base,
    id: "admin-job",
    ownerUserId: undefined,
    sourceRepo: "old",
    targetRepo: "renamed",
  };
  insertMigration(admin);
  for (const [index, change] of [
    { targetOrg: "other" },
    { targetOrg: "Dest" },
    { sourceOrg: "src" },
    { sourceProvider: "gitlab" as const },
    { targetProfileId: "different" },
    { targetPlatform: "ghes" as const },
    { sourceApiUrl: "https://source.example/api/v3" },
    { targetApiUrl: "https://target.example/api/v3" },
  ].entries()) {
    insertMigration({ ...base, id: `private-${index}`, sourceRepo: `private-${index}`, ...change });
    expect(getVisibleDetail("bob", `private-${index}`)).toBeNull();
  }
  insertEvent({
    migrationId: admin.id,
    eventType: "step",
    phase: "EXPORTING",
    payload: { message: "sensitive provider data", executorPhase: "mapping" },
    createdAt: "now",
  });
  insertEvent({
    migrationId: "private-0",
    eventType: "banner",
    phase: null,
    payload: { message: "private event" },
    createdAt: "now",
  });
  expect(getVisibleJob("bob", admin.id)).toMatchObject({
    targetRepo: "renamed",
    requestOptions: null,
  });
  expect(getVisibleDetail("bob", admin.id)?.events).toMatchObject([
    {
      migrationId: "admin-job",
      phase: "EXPORTING",
      payload: { message: "mapping", executorPhase: "mapping" },
    },
  ]);
  expect(ownJobActions("bob", id!)).toEqual({ canRestart: false, canCancel: false });
  expect(listVisibleJobs("bob")).toHaveLength(2);
  const dashboard = visibleDashboard("bob", "", paging, 1);
  expect(dashboard.migrations.total).toBe(2);
  expect(dashboard.stateCounts?.failed).toBe(2);
  expect(dashboard.batches.data[0]?.totalCount).toBe(2);
  expect(visibleDashboard("bob", "private", paging, 1)).toMatchObject({
    migrations: { total: 0 },
    batches: { total: 0 },
  });
  expect(visibleDashboard("bob", "sensitive", paging, 1).migrations.total).toBe(0);
  expect(visibleDashboard("bob", "renamed", paging, 1)).toMatchObject({
    migrations: { total: 1 },
    batches: { data: [{ totalCount: 2 }] },
  });
  expect(visibleBatch("bob", batchId, { page: 2, limit: 1 })).toMatchObject({
    summary: { totalCount: 2, failedCount: 2 },
    migrations: { total: 2, data: [{ id }] },
  });
  expect(visibleBatch("bob", batchId, paging)?.migrations.data.map((job) => job.id)).toEqual([
    admin.id,
    id!,
  ]);
  getDb().run("DELETE FROM self_service_grants WHERE user_id='bob'");
  expect(getVisibleDetail("bob", admin.id)).toBeNull();
  expect(listVisibleJobs("bob")).toHaveLength(0);
  expect(visibleBatch("bob", batchId, paging)).toBeNull();
});

test("operator endpoints read another's job without streaming or permitting changes", async () => {
  const { selection } = fixture();
  const {
    jobIds: [id],
  } = submitOwnBatch("alice", selection);
  await Bun.sleep(0);
  insertEvent({
    migrationId: id!,
    eventType: "banner",
    phase: null,
    payload: { message: "raw remote diagnostics" },
    createdAt: "now",
  });
  const event = (user: string, body = {}) =>
    ({
      locals: { user: { id: user, role: "operator" } },
      params: { id },
      url: new URL("http://localhost/events?download=1"),
      request: new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    }) as never;
  expect((await readRoute(event("bob"))).status).toBe(200);
  const log = await logRoute(event("bob"));
  expect(log.headers.get("content-type")).toContain("ndjson");
  expect(await log.text()).not.toContain("raw remote diagnostics");
  expect((await cancelRoute(event("bob"))).status).toBe(404);
  expect((await restartRoute(event("bob"))).status).toBe(404);
  expect((await restartRoute(event("alice", { targetOrg: "other" }))).status).toBe(400);
  expect((await restartRoute(event("alice"))).status).toBe(200);
  await Bun.sleep(0);
  getDb().run("DELETE FROM self_service_grants WHERE user_id IN ('alice','bob')");
  expect((await logRoute(event("bob"))).status).toBe(404);
  expect((await readRoute(event("bob"))).status).toBe(404);
  expect((await restartRoute(event("alice"))).status).toBe(404);
  expect(getMigration(id!)?.state).toBe("failed");
  getDb().run("UPDATE migrations SET state='queued' WHERE id=?", [id!]);
  expect((await cancelRoute(event("alice"))).status).toBe(404);
  expect(getMigration(id!)?.state).toBe("queued");
});
