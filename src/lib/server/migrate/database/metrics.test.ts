import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { getMigrationMetrics } from "./metrics";
import { migrateStore } from "./schema";

beforeEach(() => initStore(":memory:", [migrateStore]));
afterEach(closeStore);

function insert(
  id: string,
  source: string,
  target: string,
  state: string,
  duration: number | null,
  batch: string | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO migrations
     (id, source_provider, target_platform, state, elapsed_seconds, batch_id,
      source_api_url, source_org, source_repo, target_org, target_repo, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'https://example.com', 'private-org', ?, 'target', ?, '2026-01-01')`,
    )
    .run(id, source, target, state, duration, batch, id, id);
}

function sample(metrics: string, name: string, labels: string): number {
  const prefix = `${name}{${labels}} `;
  const line = metrics.split("\n").find((entry) => entry.startsWith(prefix));
  if (!line) throw new Error(`Missing sample ${prefix}`);
  return Number(line.slice(prefix.length));
}

describe("migration metrics", () => {
  test("aggregates retained rows with bounded labels, accurate durations, and zero states", () => {
    insert("a", "github", "ghec", "succeeded", 10);
    insert("b", "github", "ghec", "succeeded", 20);
    insert("c", "github", "ghec", "succeeded", null);
    insert("d", "gitlab", "ghes", "failed", -1, "batch-1");
    insert("e", "gitlab", "ghes", "failed", 0, "batch-1");
    insert("f", "github", "unexpected-target", "unexpected-state", 4);
    insert("g", "github", "unexpected-target", "another-state", 6);
    insert("h", "unsupported-provider", "ghec", "succeeded", 100);

    const metrics = getMigrationMetrics();
    const success = 'source="github",target="ghec",mode="single",state="succeeded"';
    const failure = 'source="gitlab",target="ghes",mode="batch",state="failed"';
    const unknown = 'source="github",target="other",mode="single",state="other"';
    expect(metrics).toContain("# TYPE gh_migrate_migrations gauge\n");
    expect(metrics.endsWith("\n")).toBe(true);
    expect(metrics).not.toContain("private-org");
    expect(metrics).not.toContain("unexpected-target");
    expect(sample(metrics, "gh_migrate_migrations", success)).toBe(3);
    expect(sample(metrics, "gh_migrate_migration_duration_observations", success)).toBe(2);
    expect(sample(metrics, "gh_migrate_migration_duration_observed_seconds", success)).toBe(30);
    expect(sample(metrics, "gh_migrate_migrations", failure)).toBe(2);
    expect(sample(metrics, "gh_migrate_migration_duration_observations", failure)).toBe(1);
    expect(sample(metrics, "gh_migrate_migrations", unknown)).toBe(2);
    expect(sample(metrics, "gh_migrate_migration_duration_observed_seconds", unknown)).toBe(10);
    expect(
      sample(
        metrics,
        "gh_migrate_migrations",
        'source="github",target="ghec",mode="single",state="running"',
      ),
    ).toBe(0);
  });

  test("reflects state changes and deletion without presenting counts as counters", () => {
    insert("a", "github", "ghec", "running", null);
    getDb().run("UPDATE migrations SET state = 'succeeded', elapsed_seconds = 12 WHERE id = 'a'");
    const success = 'source="github",target="ghec",mode="single",state="succeeded"';
    expect(sample(getMigrationMetrics(), "gh_migrate_migrations", success)).toBe(1);
    getDb().run("DELETE FROM migrations WHERE id = 'a'");
    expect(sample(getMigrationMetrics(), "gh_migrate_migrations", success)).toBe(0);
  });
});
