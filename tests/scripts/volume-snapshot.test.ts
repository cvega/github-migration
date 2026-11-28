import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStore, getDb, initStore } from "../../src/lib/server/core/db";
import { migrateStore } from "../../src/lib/server/migrate/database/schema";

const helper = new URL("../../scripts/packaging/volume-snapshot.sh", import.meta.url).pathname;
let root: string;
function dir(name: string) {
  return join(root, name);
}
function snapshot(mode: string, data = "current", archives = "archives") {
  const result = Bun.spawnSync(["sh", helper, mode, dir("bundle"), dir(data), dir(archives)]);
  return result.exitCode === 0 ? "ok" : result.stderr.toString().trim();
}
function record(state: string) {
  initStore(dir("current/gh-migrate.db"), [migrateStore]);
  getDb().run(
    `INSERT INTO migrations(id,source_api_url,source_org,source_repo,target_org,target_repo,state,started_at)
    VALUES(?, 'https://api.github.com','source','repo','dest','repo',?,'now')`,
    [state, state],
  );
  closeStore();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volume-restore-"));
  for (const name of ["current", "archives", "fresh-data", "fresh-archives"]) mkdirSync(dir(name));
  record("succeeded");
  writeFileSync(dir("archives/export"), "matching archive");
  expect(snapshot("backup")).toBe("ok");
});
afterEach(() => {
  closeStore();
  rmSync(root, { recursive: true, force: true });
});

test("restores the paired database and archives to fresh directories only", () => {
  expect(snapshot("check-current")).toBe("ok");
  expect(snapshot("restore", "fresh-data", "fresh-archives")).toBe("ok");
  expect(snapshot("check-current", "fresh-data")).toBe("ok");
  expect(readFileSync(dir("fresh-archives/export"), "utf8")).toBe("matching archive");
  expect(snapshot("restore", "current", "archives")).toContain("fresh empty volumes");
});
test("refuses the same empty destination twice", () => {
  expect(snapshot("restore", "fresh-data", "fresh-data")).toContain("volumes must be distinct");
});
test.each(["missing", "corrupt"] as const)(
  "a %s archive cannot damage the current or restore volumes",
  (failure) => {
    const file = dir("bundle/archives.tar");
    if (failure === "missing") unlinkSync(file);
    else writeFileSync(file, "corrupt");
    expect(snapshot("restore", "fresh-data", "fresh-archives")).not.toBe("ok");
    expect(Bun.file(dir("fresh-data/gh-migrate.db")).size).toBe(0);
    expect(readFileSync(dir("archives/export"), "utf8")).toBe("matching archive");
    initStore(dir("current/gh-migrate.db"), [migrateStore], { runStartupHooks: false });
    expect(getDb().query("SELECT state FROM migrations").all()).toEqual([{ state: "succeeded" }]);
  },
);
test("refuses unresolved and post-snapshot work before the switch", () => {
  record("failed");
  expect(snapshot("check-current")).toContain("history changed");
  record("reconciliation_required");
  expect(snapshot("check-current")).toContain("reconcile Needs review");
  expect(snapshot("backup")).toContain("reconcile Needs review");
});
test("a failed parent does not conceal an outstanding GHES checkpoint", () => {
  record("failed");
  initStore(dir("current/gh-migrate.db"), [migrateStore], { runStartupHooks: false });
  getDb().run(`INSERT INTO ghes_import_jobs(id,migration_id,phase,ghes_import_id,created_at,updated_at)
    VALUES('job','failed','auditing','retained-guid','now','now')`);
  closeStore();
  expect(snapshot("check-current")).toContain("outstanding GHES checkpoints");
});
