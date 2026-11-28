import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSchema } from "../../src/lib/server/core/db";
import { DOMAIN_STORES } from "../../src/lib/server/schemas";

test("migration-only seed spans six months, preserves other data, and rolls back on failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "migration-seed-"));
  const path = join(directory, "gh-migrate.db");
  const seed = () =>
    Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "seed.ts"), "--migrations-only"],
      env: { ...process.env, DATA_DIR: directory },
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    let db = new Database(path);
    initializeSchema(db, DOMAIN_STORES);
    db.run(`INSERT INTO migrations
      (id, source_api_url, source_org, source_repo, target_org, target_repo, state, started_at)
      VALUES ('keep-me', 'https://api.github.com', 'source', 'repo', 'target', 'repo', 'succeeded', '2026-01-01T00:00:00.000Z')`);
    db.close();

    const result = seed();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    db = new Database(path, { readonly: true });
    const summary = db
      .query(`SELECT COUNT(*) AS total, MIN(started_at) AS oldest, MAX(started_at) AS newest,
      SUM(CASE WHEN started_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS recent,
      SUM(CASE WHEN started_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END) AS future
      FROM migrations WHERE id LIKE 'seed-%'`)
      .get() as {
      total: number;
      oldest: string;
      newest: string;
      recent: number;
      future: number;
    };
    expect(summary.total).toBeGreaterThanOrEqual(2500);
    expect(Date.now() - Date.parse(summary.oldest)).toBeGreaterThan(180 * 86_400_000);
    expect(Date.now() - Date.parse(summary.oldest)).toBeLessThan(185 * 86_400_000);
    expect(summary.recent).toBeGreaterThan(0);
    expect(summary.future).toBe(0);
    expect(db.query("SELECT COUNT(*) AS count FROM migrations WHERE id = 'keep-me'").get()).toEqual(
      { count: 1 },
    );
    expect(db.query("SELECT COUNT(*) AS count FROM profile_runs").get()).toEqual({ count: 0 });
    db.close();

    db = new Database(path);
    db.run(
      "CREATE TRIGGER fail_seed BEFORE INSERT ON migrations WHEN NEW.id LIKE 'seed-%' BEGIN SELECT RAISE(ABORT, 'seed failure'); END",
    );
    db.close();
    expect(seed().exitCode).not.toBe(0);
    db = new Database(path, { readonly: true });
    expect(
      db.query("SELECT COUNT(*) AS count FROM migrations WHERE id LIKE 'seed-%'").get(),
    ).toEqual({ count: summary.total });
    expect(db.query("SELECT COUNT(*) AS count FROM migrations WHERE id = 'keep-me'").get()).toEqual(
      { count: 1 },
    );
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
