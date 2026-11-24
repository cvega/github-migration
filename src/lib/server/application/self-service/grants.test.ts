import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import {
  assignGrant,
  type Grant,
  grantsForSource,
  listAdminGrants,
  listGrants,
  revokeGrant,
} from "./grants";

const cloud: Grant = {
  sourceProvider: "github",
  sourceApiUrl: "https://api.github.com",
  namespace: "team",
  targetProfileId: "ghec",
  targetOrg: "landing",
  canMigrate: false,
};
const gitlab: Grant = {
  ...cloud,
  sourceProvider: "gitlab",
  sourceApiUrl: "https://gitlab.example/api/v4",
};
const bitbucket: Grant = {
  ...cloud,
  sourceProvider: "bitbucket-server",
  sourceApiUrl: "https://bb.example/rest/api/1.0",
};
const server: Grant = {
  ...bitbucket,
  targetProfileId: "enterprise",
  targetOrg: "on-prem",
  canMigrate: true,
};
const settings = {
  GH_TARGET_ORG: "landing,other",
  GHES_TARGET_API_URL: "https://ghes.example/api/v3",
  GHES_TARGET_ID: "enterprise",
  GHES_TARGET_ORG: "on-prem",
  GITLAB_SOURCE_API_URL: "https://gitlab.example",
  BITBUCKET_SERVER_URL: "https://bb.example",
};
const original = new Map(Object.keys(settings).map((key) => [key, process.env[key]]));

beforeEach(() => {
  Object.assign(process.env, settings);
  initStore(":memory:", [authStore]);
  const insert =
    getDb().query(`INSERT INTO app_users (id, username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, 'hash', ?, 'now', 'now')`);
  for (const id of ["admin", "alice", "bob"])
    insert.run(id, id, id === "admin" ? "admin" : "operator");
});
afterEach(() => {
  closeStore();
  for (const [key, value] of original)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

describe("exact operator grants", () => {
  test("isolates users, provider, instance and group path across all four supported routes", () => {
    const subgroup = { ...gitlab, namespace: "team/child" };
    assignGrant("admin", "alice", gitlab);
    assignGrant("admin", "alice", bitbucket);
    assignGrant("admin", "bob", subgroup);
    assignGrant("admin", "bob", cloud);
    assignGrant("admin", "bob", { ...server, namespace: "OPS" });
    expect(listGrants("alice")).toMatchObject([bitbucket, gitlab]);
    expect(listGrants("bob")).toHaveLength(3);
    expect(grantsForSource("alice", "gitlab", gitlab.sourceApiUrl, "team/child")).toEqual([]);
    expect(grantsForSource("bob", "gitlab", gitlab.sourceApiUrl, "team")).toEqual([]);
    expect(grantsForSource("alice", "gitlab", "https://elsewhere.example/api/v4", "team")).toEqual(
      [],
    );
    expect(grantsForSource("alice", "github", cloud.sourceApiUrl, "team")).toEqual([]);
    expect(grantsForSource("bob", "bitbucket-server", server.sourceApiUrl, "OPS")).toMatchObject([
      { canMigrate: true },
    ]);
  });

  test("restricts assignments to active named operators, configured supported routes and literal namespaces", () => {
    for (const invalid of [
      { ...gitlab, targetProfileId: server.targetProfileId, targetOrg: server.targetOrg },
      { ...cloud, targetProfileId: server.targetProfileId, targetOrg: server.targetOrg },
      { ...cloud, targetOrg: "unknown" },
      { ...cloud, targetProfileId: "" },
      { ...gitlab, namespace: "team/*" },
      { ...gitlab, namespace: "team%2fother" },
      { ...gitlab, sourceApiUrl: "https://other.example/api/v4" },
    ])
      expect(() => assignGrant("admin", "bob", invalid)).toThrow();
    expect(() => assignGrant("alice", "bob", cloud)).toThrow();
    expect(() => assignGrant("admin", "admin", cloud)).toThrow();
    expect(() => assignGrant("admin", "absent", cloud)).toThrow();
    getDb().run("UPDATE app_users SET is_active = 0 WHERE id = 'bob'");
    expect(() => assignGrant("admin", "bob", cloud)).toThrow();
    expect(listAdminGrants()).toEqual([]);
  });

  test("multiple destinations never remap a shared route; revoke only the named assignment", () => {
    assignGrant("admin", "alice", cloud);
    expect(() => assignGrant("admin", "alice", { ...cloud, canMigrate: true })).toThrow();
    assignGrant("admin", "bob", { ...cloud, canMigrate: true });
    const [first, second] = listAdminGrants();
    assignGrant("admin", "alice", { ...cloud, targetOrg: "other" });
    revokeGrant("admin", first!.id);
    expect(listGrants("alice")).toMatchObject([{ targetOrg: "other", canMigrate: false }]);
    expect(listGrants("bob")[0]?.canMigrate).toBe(true);
    revokeGrant("admin", second!.id);
    expect(
      getDb()
        .query(
          "SELECT actor_user_id, target_user_id, action, resource_id, metadata FROM audit_events ORDER BY id",
        )
        .all(),
    ).toEqual([
      expect.objectContaining({
        action: "grant.assigned",
        actor_user_id: "admin",
        target_user_id: "alice",
        resource_id: first!.id,
      }),
      expect.objectContaining({ action: "grant.assigned", target_user_id: "bob" }),
      expect.objectContaining({ action: "grant.assigned", target_user_id: "alice" }),
      expect.objectContaining({
        action: "grant.revoked",
        actor_user_id: "admin",
        target_user_id: "alice",
        resource_id: first!.id,
        metadata: expect.stringContaining("landing"),
      }),
      expect.objectContaining({ action: "grant.revoked", target_user_id: "bob" }),
    ]);
  });

  test("fails closed when source, destination, or user eligibility changes", () => {
    assignGrant("admin", "alice", server);
    for (const [key, value] of [
      ["GHES_TARGET_API_URL", "https://elsewhere.example/api/v3"],
      ["GHES_TARGET_ORG", ""],
      ["BITBUCKET_SERVER_URL", "https://replacement.example"],
    ] as const) {
      process.env[key] = value;
      expect(listGrants("alice")).toEqual([]);
      expect(
        grantsForSource("alice", server.sourceProvider, server.sourceApiUrl, server.namespace),
      ).toEqual([]);
      process.env[key] = settings[key];
    }
    expect(listGrants("alice")).toMatchObject([server]);
    for (const update of ["is_active = 0", "role = 'admin'", "must_change_password = 1"]) {
      getDb().run(`UPDATE app_users SET ${update} WHERE id = 'alice'`);
      expect(listGrants("alice")).toEqual([]);
      getDb().run(
        "UPDATE app_users SET is_active = 1, role = 'operator', must_change_password = 0 WHERE id = 'alice'",
      );
    }
  });
});
