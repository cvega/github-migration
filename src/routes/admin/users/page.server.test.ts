import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthUser } from "$lib/auth-user";
import { authStore } from "$lib/server/core/auth/schema";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { load } from "./+page.server";

const ADMIN: AuthUser = {
  id: "admin",
  username: "admin",
  displayName: null,
  role: "admin",
  isActive: true,
  mustChangePassword: false,
};

beforeEach(() => {
  initStore(":memory:", [authStore]);
  const insert = getDb().prepare(
    `INSERT INTO app_users
     (id, username, password_hash, role, is_active, must_change_password, created_at, updated_at)
     VALUES (?, ?, 'fixture-hash', 'operator', 1, 0, '2026-08-29', '2026-08-29')`,
  );
  for (let index = 1; index <= 13; index += 1) {
    const username = `user-${index.toString().padStart(2, "0")}`;
    insert.run(username, username);
  }
});

afterEach(closeStore);

async function loadUsers(path: string) {
  const result = await load({
    locals: { authEnabled: true, user: ADMIN },
    url: new URL(path, "http://localhost"),
  } as Parameters<typeof load>[0]);
  if (!result) throw new Error("User loader did not return data");
  return result;
}

describe("user management loader", () => {
  test("paginates filtered users and clamps out-of-range pages", async () => {
    const secondPage = await loadUsers("/admin/users?page=2");
    expect(secondPage.pagination).toEqual({ page: 2, totalPages: 2, total: 13, limit: 10 });
    expect(secondPage.users.map((user: AuthUser) => user.username)).toEqual([
      "user-11",
      "user-12",
      "user-13",
    ]);

    const clampedPage = await loadUsers("/admin/users?page=99");
    expect(clampedPage.pagination.page).toBe(2);

    const filtered = await loadUsers("/admin/users?q=user-1&page=2");
    expect(filtered.pagination).toEqual({ page: 1, totalPages: 1, total: 4, limit: 10 });
    expect(filtered.users).toHaveLength(4);
  });
});
