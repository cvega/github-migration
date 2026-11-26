import assert from "node:assert/strict";
import { join } from "node:path";
import type { BitbucketServerClient } from "$lib/server/source/bitbucket/client";
import { discoverBitbucketInventory } from "$lib/server/source/bitbucket/inventory";
import { collectBitbucketProfileEnrichment } from "$lib/server/source/bitbucket/profile";
import { assertExactMetrics, assertPaginatedFixture } from "../assertions";

export const bitbucketComposeFile = join(import.meta.dir, "compose.yml");

export async function verifyBitbucketContract(
  client: BitbucketServerClient,
  projectKey: string,
  paginatedKey: string,
  paginatedCount: number,
): Promise<void> {
  const inventory = await discoverBitbucketInventory(client, projectKey);
  const profile = await collectBitbucketProfileEnrichment(client, inventory);
  const rich = `${projectKey}/service-api`;
  assert.deepEqual(profile.projects.map((project) => project.path).sort(), [
    rich,
    `${projectKey}/web-client`,
    `${projectKey}/worker`,
  ]);
  for (const { path, metrics } of profile.projects) {
    assertExactMetrics(path, metrics, {
      commits: path === rich ? 3 : 1,
      pullRequests: path === rich ? 1 : 0,
      branches: path === rich ? 2 : 1,
      tags: path === rich ? 1 : 0,
      forks: 0,
    });
  }
  const paged = await discoverBitbucketInventory(client, paginatedKey);
  assertPaginatedFixture(paged, `${paginatedKey}/repository`, paginatedCount, "exact");
}
