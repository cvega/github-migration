import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { authStore } from "$lib/server/core/auth/schema";
import { findUserById } from "$lib/server/core/auth/users";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { actions, load } from "./+page.server";

const keys = [
  "GHES_TARGET_API_URL",
  "GHES_TARGET_ID",
  "GHES_TARGET_ADMIN_PAT",
  "GHES_TARGET_ORG",
] as const;
const saved = new Map(keys.map((k) => [k, process.env[k]]));
const api = "https://fixture.invalid/api/v3";
const connection = JSON.stringify(["fixture", api]);
beforeEach(() => {
  Object.assign(process.env, {
    GHES_TARGET_API_URL: api,
    GHES_TARGET_ID: "fixture",
    GHES_TARGET_ADMIN_PAT: "unit-test-only",
    GHES_TARGET_ORG: "",
  });
  initStore(":memory:", [authStore]);
  getDb().run(`INSERT INTO app_users(id,username,password_hash,role,created_at,updated_at) VALUES
    ('admin','admin','hash','admin','now','now'),('reader','reader','hash','operator','now','now')`);
});
afterEach(() => {
  closeStore();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function event(id: string, fields: Record<string, string>) {
  return {
    locals: { user: findUserById(id), authEnabled: true },
    request: new Request("https://dashboard.invalid/admin/targets", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
  } as Parameters<typeof actions.add>[0];
}

test("discover reads one page on the selected target without granting or listing it until an administrator chooses Add", async () => {
  const remote = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([{ login: "engineering" }], {
      headers: { link: '<https://fixture.invalid/api/v3/user/orgs?page=3>; rel="next"' },
    }),
  );
  try {
    expect(await actions.discover(event("admin", { connection, cursor: "1" }))).toEqual({
      discovery: { key: connection, organizations: ["engineering"], next: 2 },
    });
    const [url, request] = remote.mock.calls[0]!;
    expect(String(url)).toContain(`${api}/user/orgs?`);
    expect(new URL(String(url)).searchParams.get("page")).toBe("2");
    expect(new Headers(request?.headers).get("authorization")).toContain("unit-test-only");
    expect(getDb().query("SELECT * FROM target_organizations").all()).toEqual([]);
    expect(await actions.add(event("admin", { connection, org: "engineering" }))).toHaveProperty(
      "success",
    );
    expect(await actions.add(event("admin", { connection, org: "ENGINEERING" }))).toMatchObject({
      status: 400,
    });
    expect(getDb().query("SELECT id FROM self_service_grants").all()).toEqual([]);
    expect(await actions.remove(event("admin", { connection, org: "engineering" }))).toHaveProperty(
      "success",
    );
  } finally {
    remote.mockRestore();
  }
});

test("only admins manage targets; stale connections and malformed values never contact a provider", async () => {
  const remote = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("unexpected provider request"),
  );
  try {
    const body = { connection, org: "engineering" };
    for (const [id, status] of [
      ["", 401],
      ["reader", 403],
    ] as const) {
      const e = event(id, body);
      expect(() => load(e as Parameters<typeof load>[0])).toThrow();
      for (const action of [actions.add, actions.remove, actions.discover])
        await expect(action(e)).rejects.toMatchObject({ status });
    }
    expect(await actions.add(event("admin", { connection }))).toMatchObject({ status: 400 });
    expect(
      await actions.add(event("admin", { connection, org: "https://wrong.invalid/org" })),
    ).toMatchObject({ status: 400 });
    expect(await actions.discover(event("admin", { connection, cursor: "invalid" }))).toMatchObject(
      { status: 400 },
    );
    expect(
      await actions.discover(
        event("admin", { connection: JSON.stringify(["fixture", "https://old.invalid"]) }),
      ),
    ).toMatchObject({ status: 400 });
    expect(remote).not.toHaveBeenCalled();
  } finally {
    remote.mockRestore();
  }
});
