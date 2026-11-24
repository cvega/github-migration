import { afterEach, beforeEach, expect, test } from "bun:test";
import { configuredGrantSource, listGrants } from "$lib/server/application/self-service/grants";
import { authStore } from "$lib/server/core/auth/schema";
import { findUserById } from "$lib/server/core/auth/users";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { profileStore } from "$lib/server/profile/database/schema";
import { actions, load } from "./+page.server";

const originalOrg = process.env.GH_TARGET_ORG;
beforeEach(() => {
  process.env.GH_TARGET_ORG = "landing,other";
  initStore(":memory:", [authStore, profileStore]);
  getDb()
    .query(`INSERT INTO profile_runs(id,source_provider,source_api_url,org,state,started_at,completed_at)
    VALUES ('run','github',?,'team','completed','now','now')`)
    .run(configuredGrantSource("github"));
  getDb().run(`INSERT INTO app_users (id, username, password_hash, role, is_active, created_at, updated_at)
    VALUES ('admin','admin','hash','admin',1,'now','now'),
           ('alice','alice','hash','operator',1,'now','now'),
           ('bob','bob','hash','operator',1,'now','now'),
           ('disabled','disabled','hash','operator',0,'now','now')`);
});
afterEach(() => {
  closeStore();
  if (originalOrg === undefined) delete process.env.GH_TARGET_ORG;
  else process.env.GH_TARGET_ORG = originalOrg;
});

function event(actor: string, id: string, input: Record<string, string | string[]> = {}) {
  const url = new URL(`https://example.test/admin/users/${id}`);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    for (const item of [value].flat()) body.append(key, item);
  return {
    url,
    locals: { user: findUserById(actor), authEnabled: true },
    params: { id },
    request: new Request(url, {
      method: "POST",
      body,
    }),
  };
}
async function page(actor: string, id: string) {
  const data = await load(event(actor, id) as Parameters<typeof load>[0]);
  if (!data) throw new Error("Expected page data");
  return data;
}
function action(
  name: "assign" | "removeAssignment",
  actor: string,
  id: string,
  input: Record<string, string | string[]>,
) {
  const submit = actions[name]!;
  return submit(event(actor, id, input) as Parameters<typeof submit>[0]);
}

test("grants multiple destinations atomically for the panel's user without pinning other users", async () => {
  const data = await page("admin", "alice");
  const [first, other] = data.destinations;
  const fields = {
    userId: "bob",
    source: data.profiles[0]!.key,
    route: [first!.key, other!.key],
    permission: "view",
  };
  expect(
    await action("assign", "admin", "alice", { ...fields, route: [first!.key, "stale"] }),
  ).toMatchObject({ status: 400 });
  expect(listGrants("alice")).toEqual([]);
  expect(await action("assign", "admin", "disabled", fields)).toMatchObject({ status: 400 });
  expect(await action("assign", "admin", "alice", fields)).toMatchObject({
    success: "Assigned 2 destinations.",
  });
  expect(await action("assign", "admin", "alice", fields)).toMatchObject({ status: 400 });
  expect(listGrants("alice")[0]?.canMigrate).toBe(false);
  const bob = await page("admin", "bob");
  expect(bob.grants).toEqual([]);
  expect(bob.destinations).toEqual([first!, other!]);
  expect(await action("assign", "admin", "bob", { ...fields, route: other!.key })).toMatchObject({
    success: "Assigned 1 destination.",
  });
  const grantId = (await page("admin", "alice")).grants[0]!.id;
  expect(await action("removeAssignment", "admin", "bob", { grantId })).toMatchObject({
    status: 400,
  });
  expect(listGrants("alice")).toHaveLength(2);
  expect(await action("removeAssignment", "admin", "alice", { grantId })).toMatchObject({
    success: "Profile access removed.",
  });
  expect(listGrants("alice")).toHaveLength(1);
  expect(listGrants("bob")).toHaveLength(1);
});

test("rejects forged options and options that are no longer configured or completed", async () => {
  const data = await page("admin", "alice");
  const fields = {
    source: data.profiles[0]!.key,
    route: data.destinations[0]!.key,
    permission: "migrate",
  };
  for (const input of [
    { ...fields, route: "unknown" },
    { ...fields, permission: "owner" },
  ])
    expect(await action("assign", "admin", "alice", input)).toMatchObject({ status: 400 });
  process.env.GH_TARGET_ORG = "changed";
  expect(await action("assign", "admin", "alice", fields)).toMatchObject({ status: 400 });
  process.env.GH_TARGET_ORG = "landing,other";
  getDb().run("UPDATE profile_runs SET state = 'running', completed_at = NULL");
  expect((await page("admin", "alice")).profiles).toEqual([]);
  expect(await action("assign", "admin", "alice", fields)).toMatchObject({ status: 400 });
  expect(listGrants("alice")).toEqual([]);
});

test("only an authenticated administrator can load or change assignments", async () => {
  for (const [actor, status] of [
    ["alice", 403],
    ["missing", 401],
  ] as const) {
    await expect(page(actor, "bob")).rejects.toMatchObject({ status });
    for (const name of ["assign", "removeAssignment"] as const)
      await expect(action(name, actor, "bob", {})).rejects.toMatchObject({ status });
  }
});

test("51 profiled projects stay selectable with a two-project migration scope; only the chosen pair is delegated", async () => {
  const keys = [
    "BITBUCKET_SERVER_URL",
    "BITBUCKET_SERVER_PROJECT_KEYS",
    "PROFILE_CONNECTION_SCOPE",
  ] as const;
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env.BITBUCKET_SERVER_URL = "https://bb.example";
    process.env.BITBUCKET_SERVER_PROJECT_KEYS = "P00,P01";
    process.env.PROFILE_CONNECTION_SCOPE = "bitbucket-server";
    const api = configuredGrantSource("bitbucket-server");
    getDb().run("DELETE FROM profile_runs");
    const insert =
      getDb().query(`INSERT INTO profile_runs(id,source_provider,source_api_url,org,state,started_at,completed_at)
      VALUES (?,'bitbucket-server',?,?,'completed','start',?)`);
    for (let i = 0; i < 51; i++) {
      const name = `P${String(i).padStart(2, "0")}`;
      insert.run(name, api, name, "2026-01-01");
    }
    insert.run("second-report", api, "P50", "2026-02-01");
    const { profiles } = await page("admin", "alice");
    expect(profiles).toHaveLength(51);
    const restricted = profiles.find((p) => p.namespace === "P50")!;
    expect(restricted.id).toBe("second-report");
    const eventFor = (key: string) => {
      const req = event("admin", "alice");
      req.url.searchParams.set("source", key);
      return req as Parameters<typeof load>[0];
    };
    const choice = (await load(eventFor(restricted.key)))!.destinations[0]!;
    expect(choice.migrationRestriction).toContain("P50");
    const input = { source: restricted.key, route: choice.key, permission: "migrate" };
    expect(await action("assign", "admin", "alice", input)).toMatchObject({ status: 400 });
    expect(
      await action("assign", "admin", "alice", { ...input, permission: "view" }),
    ).toHaveProperty("success");
    expect(listGrants("alice")).toMatchObject([
      { namespace: "P50", targetOrg: choice.targetOrg, canMigrate: false },
    ]);
    expect(listGrants("bob")).toEqual([]);
    expect(
      (await load(eventFor(profiles[0]!.key)))!.destinations[0]?.migrationRestriction,
    ).toBeNull();
    process.env.GH_TARGET_ORG = "";
    const empty = await load(eventFor(restricted.key));
    expect(empty!.profiles).toHaveLength(51);
    expect(empty!.destinations).toEqual([]);
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
});
