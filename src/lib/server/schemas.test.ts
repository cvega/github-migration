import { beforeEach, describe, expect, test } from "bun:test";
import { authStore } from "./core/auth/schema";
import { getDb, initStore } from "./core/db";
import { migrateStore } from "./migrate/database/schema";
import { profileStore } from "./profile/database/schema";
import { DOMAIN_STORES } from "./schemas";

beforeEach(() => initStore(":memory:", DOMAIN_STORES));

describe("domain schema registry", () => {
  test("registers durable domains in dependency-safe startup order", () => {
    expect(DOMAIN_STORES).toEqual([authStore, migrateStore, profileStore]);
  });

  test("applies auth, migrate, and profile schemas to the same database", () => {
    const tables = getDb()
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);

    expect(tables).toContain("app_users");
    expect(tables).toContain("app_sessions");
    expect(tables).toContain("migrations");
    expect(tables).toContain("migration_batch_items");
    expect(tables).toContain("profile_runs");
    expect(tables).toContain("profile_repos");
  });
});
