import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { bitbucketArchiveRecords } from "./archive-records";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mapping-records-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const org = "https://bitbucket.example/projects/OPS";
const repo = `${org}/repos/tools`;

async function archive(extra: Record<string, string>) {
  const path = join(dir, "export.tar.gz");
  const tar = new Bun.Archive({
    "organizations_1.json": JSON.stringify([{ url: org }]),
    "repositories_1.json": JSON.stringify([{ url: repo }]),
    ...extra,
  });
  await Bun.write(path, Bun.gzipSync(await tar.bytes()));
  return path;
}

test("reads mapping identities from root manifests without parsing repository content", async () => {
  const user = "https://bitbucket.example/users/alice";
  const team = `${org}/groups/admins`;
  const path = await archive({
    "users_2.json": JSON.stringify([{ url: user }]),
    "teams_1.json": JSON.stringify([{ url: team }]),
    "git-data/users_1.json": "not a manifest",
  });
  const rows = parse(await bitbucketArchiveRecords(path), { columns: true });
  expect(rows).toHaveLength(4);
  for (const [model, url] of Object.entries({ organization: org, repository: repo, user, team })) {
    expect(rows).toContainEqual({
      model_name: model,
      source_url: url,
      target_url: "",
      state: "exported",
    });
  }
});

test("rejects ambiguous repository identity instead of returning a partial mapping", async () => {
  const path = await archive({ "repositories_2.json": JSON.stringify([{ url: `${repo}-two` }]) });
  await expect(bitbucketArchiveRecords(path)).rejects.toThrow("Expected one Bitbucket repository");
});

test("rejects a manifest with a missing source URL", async () => {
  const path = await archive({ "users_1.json": '[{"name":"alice"}]' });
  await expect(bitbucketArchiveRecords(path)).rejects.toThrow("Missing source URL");
});
