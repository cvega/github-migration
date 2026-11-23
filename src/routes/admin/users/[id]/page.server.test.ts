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

function event(actor: string, id: string, input: Record<string, string> = {}) {
  return {
    locals: { user: findUserById(actor), authEnabled: true },
    params: { id },
    request: new Request(`https://example.test/admin/users/${id}`, {
      method: "POST",
      body: new URLSearchParams(input),
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
  input: Record<string, string>,
) {
  const submit = actions[name]!;
  return submit(event(actor, id, input) as Parameters<typeof submit>[0]);
}

test("assignments use the panel's user, pin the destination and cannot be revoked from another panel", async () => {
  const data = await page("admin", "alice");
  const [first, other] = data.profiles[0]!.destinations;
  const fields = { userId: "bob", route: first!.key, permission: "view" };
  expect(await action("assign", "admin", "disabled", fields)).toMatchObject({ status: 400 });
  expect(await action("assign", "admin", "alice", fields)).toMatchObject({
    success: "Profile assigned.",
  });
  expect(await action("assign", "admin", "alice", fields)).toMatchObject({ status: 400 });
  expect(listGrants("alice")[0]?.canMigrate).toBe(false);
  const bob = await page("admin", "bob");
  expect(bob.grants).toEqual([]);
  expect(bob.profiles[0]?.destinations).toEqual([first!]);
  expect(await action("assign", "admin", "bob", { ...fields, route: other!.key })).toMatchObject({
    status: 400,
  });
  const grantId = (await page("admin", "alice")).grants[0]!.id;
  expect(await action("removeAssignment", "admin", "bob", { grantId })).toMatchObject({
    status: 400,
  });
  expect(listGrants("alice")).toHaveLength(1);
  expect(await action("removeAssignment", "admin", "alice", { grantId })).toMatchObject({
    success: "Profile access removed.",
  });
  expect(listGrants("alice")).toEqual([]);
});

test("rejects forged options and options that are no longer configured or completed", async () => {
  const route = (await page("admin", "alice")).profiles[0]!.destinations[0]!.key;
  const fields = { route, permission: "migrate" };
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
