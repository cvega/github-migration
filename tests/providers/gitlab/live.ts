import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitLabClient } from "$lib/server/source/gitlab/client";
import { discoverGitLabInventory } from "$lib/server/source/gitlab/inventory";
import { collectGitLabProfileEnrichment } from "$lib/server/source/gitlab/profile";
import { assertExactMetrics, assertPaginatedFixture } from "../assertions";

export const gitlabComposeFile = join(import.meta.dir, "compose.yml");

export async function verifyGitLabContract(
  client: GitLabClient,
  namespace: string,
  paginatedNamespace: string,
  paginatedCount: number,
): Promise<void> {
  const inventory = await discoverGitLabInventory(client, namespace);
  const rich = `${namespace}/service-api`;
  const web = `${namespace}/web-client`;
  const profile = await collectGitLabProfileEnrichment(client, inventory);
  assert.deepEqual(profile.projects.map((project) => project.path).sort(), [
    `${namespace}/platform/worker`,
    rich,
    web,
  ]);
  for (const { path, metrics } of profile.projects) {
    // Protection rules depend on the instance tier and default-branch settings.
    assertExactMetrics<"issues" | "mergeRequests" | "commits" | "branches" | "tags" | "releases">(
      path,
      metrics,
      {
      issues: path === rich ? 1 : path === web ? 2 : 0,
      mergeRequests: path === rich ? 1 : 0,
      commits: path === rich ? 3 : 1,
      branches: path === rich ? 2 : 1,
      tags: path === rich ? 1 : 0,
      releases: path === rich ? 1 : 0,
      },
    );
    // Seeded projects have no CI file; the instance Auto DevOps default decides 0 or 1.
    const ci = metrics.ciConfiguration.observation;
    assert.ok(ci.kind === "exact" && (ci.value === 0 || ci.value === 1), `${path}: ciConfiguration`);
  }

  const paged = await discoverGitLabInventory(client, paginatedNamespace);
  assertPaginatedFixture(paged, `${paginatedNamespace}/project`, paginatedCount, "at-least");

  await using directory = await mkdtempDisposable(join(tmpdir(), "gitlab-contract-"));
  const archive = join(directory.path, "project.tar.gz");
  const signal = AbortSignal.timeout(5 * 60_000);
  await client.startProjectExport(rich, signal);
  for (;;) {
    const { state } = await client.getProjectExport(rich, signal);
    if (state === "finished") break;
    assert.notEqual(state, "failed", "GitLab could not export the seeded project");
    await Bun.sleep(1_000);
  }
  await client.downloadProjectExport(rich, archive, {
    signal,
    timeoutMs: 60_000,
    maxBytes: 64 * 1024 * 1024,
  });
  const files = await new Bun.Archive(Bun.file(archive)).files();
  assert.ok(
    [...files.keys()].some((name) => /(^|\/)project\.bundle$/.test(name)),
    "GitLab export lacks the seeded Git repository",
  );
}
