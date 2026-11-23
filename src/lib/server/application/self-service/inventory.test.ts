import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeStore, getDb, initStore } from "$lib/server/core/db";
import { profileStore } from "$lib/server/profile/database/schema";
import type { SourceProvider } from "$lib/source-provider";
import { listCurrentRepositories, lookupCurrentRepository } from "./inventory";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

function run(id: string, provider: SourceProvider, api: string, org: string, end: string | null) {
  getDb()
    .prepare(`INSERT INTO profile_runs
    (id, source_provider, source_api_url, org, state, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, '2026-01-01', ?)`)
    .run(id, provider, api, org, end ? "completed" : "running", end);
}

test("GitHub membership uses only the latest completed snapshot for the exact source tuple", () => {
  const grant = {
    sourceProvider: "github" as const,
    sourceApiUrl: "https://api.github.com",
    namespace: "acme",
  };
  const add = (id: string, repo: string) =>
    getDb()
      .prepare(
        "INSERT INTO profile_repos (run_id, name_with_owner, created_at) VALUES (?, ?, '2026-01-01')",
      )
      .run(id, repo);
  run("old", "github", grant.sourceApiUrl, "acme", "2026-01-01");
  run("current", "github", grant.sourceApiUrl, "acme", "2026-01-02");
  run("other-instance", "github", "https://other.invalid", "acme", "2026-01-04");
  run("other-provider", "gitlab", grant.sourceApiUrl, "acme", "2026-01-04");
  run("other-org", "github", grant.sourceApiUrl, "Acme", "2026-01-04");
  run("in-progress", "github", grant.sourceApiUrl, "acme", null);
  for (const id of ["old", "other-instance", "in-progress", "other-provider", "other-org"])
    add(id, `acme/${id}`);
  add("current", "acme/widget");
  add("current", "acme-extra/leak");
  expect(listCurrentRepositories(grant, "", 1).repos).toEqual([
    { name: "widget", path: "acme/widget" },
  ]);
  expect(lookupCurrentRepository(grant, "widget")?.path).toBe("acme/widget");
  for (const name of [
    "old",
    "in-progress",
    "leak",
    "Widget",
    "other-instance",
    "other-provider",
    "other-org",
  ]) {
    expect(lookupCurrentRepository(grant, name)).toBeNull();
  }
});

test.each(["gitlab", "bitbucket-server"] as const)(
  "%s counts and pages only direct repository paths",
  (sourceProvider) => {
    const namespace = sourceProvider === "gitlab" ? "group/sub" : "KEY";
    const grant = { sourceProvider, sourceApiUrl: "https://source.invalid/api", namespace };
    run("current", sourceProvider, grant.sourceApiUrl, namespace, "2026-01-02");
    const db = getDb();
    db.run(
      "INSERT INTO profile_source_inventories (run_id, fetched_at) VALUES ('current','2026-01-01')",
    );
    const paths = [
      `${namespace}/nested/secret`,
      `${namespace}more/secret`,
      "different/secret",
      ...Array.from({ length: 26 }, (_, n) => `${namespace}/repo-${String(n).padStart(2, "0")}`),
      `${namespace}/literal_underscore`,
    ];
    paths.forEach((path, i) => {
      db.prepare(`INSERT INTO profile_source_inventory_projects
    (run_id,position,source_id,path,payload) VALUES ('current',?,?,?,'{}')`).run(
        i,
        String(i),
        path,
      );
    });
    const page = listCurrentRepositories(grant, "REPO", 100);
    expect(page).toMatchObject({ page: 2, pages: 2, total: 26, repos: [{ name: "repo-25" }] });
    expect(listCurrentRepositories(grant, "_", 1).total).toBe(1);
    expect(listCurrentRepositories(grant, "secret", 1).total).toBe(0);
    expect(lookupCurrentRepository(grant, "nested/secret")).toBeNull();
    expect(lookupCurrentRepository(grant, "repo-00")?.path).toBe(`${namespace}/repo-00`);
  },
);
