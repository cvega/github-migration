/**
 * Tests for the REST commit-count gatherer. The `rest` client is faked, so these
 * exercise the real branch/empty guards and the delegation to
 * `countByPagination` (the `Link`-header trick) with no network.
 */
import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "$lib/server/core/github";
import { countRepoCommits } from "./commits";
import { makeDiscoveredRepo } from "./test-factories";
import type { DiscoveredRepo } from "./types";

const repo = (over: Partial<DiscoveredRepo> = {}): DiscoveredRepo =>
  makeDiscoveredRepo("widget", over);

/** A `rest` double whose `request` returns a queued response and records args. */
function mockRest(response: { headers?: Record<string, string>; data?: unknown }) {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const rest = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      return { headers: response.headers ?? {}, data: response.data ?? [{}] };
    },
  } as unknown as GitHubClient;
  return { rest, calls };
}

describe("countRepoCommits", () => {
  test("counts via the Link header's rel=last page number", async () => {
    const { rest, calls } = mockRest({
      headers: {
        link: '<https://api.github.com/repositories/1/commits?sha=main&per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/commits?sha=main&per_page=1&page=4096>; rel="last"',
      },
    });

    expect(await countRepoCommits(rest, repo())).toBe(4096);
    // Hits the commits endpoint for the right repo, scoped to the default branch.
    expect(calls[0]?.route).toBe("GET /repos/{owner}/{repo}/commits");
    expect(calls[0]?.params).toMatchObject({
      owner: "acme",
      repo: "widget",
      sha: "main",
      per_page: 1,
    });
  });

  test("returns the item count when there's no rel=last link (0 or 1 commit)", async () => {
    const { rest } = mockRest({ headers: {}, data: [{ sha: "abc" }] });
    expect(await countRepoCommits(rest, repo())).toBe(1);
  });

  test("scopes the count to the repo's own default branch", async () => {
    const { rest, calls } = mockRest({ data: [{}] });
    await countRepoCommits(rest, repo({ defaultBranch: "develop" }));
    expect(calls[0]?.params).toMatchObject({ sha: "develop" });
  });

  test("returns 0 without a request for an empty repo", async () => {
    const { rest, calls } = mockRest({ data: [{}] });
    expect(await countRepoCommits(rest, repo({ isEmpty: true }))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("returns 0 without a request when there is no default branch", async () => {
    const { rest, calls } = mockRest({ data: [{}] });
    expect(await countRepoCommits(rest, repo({ defaultBranch: null }))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("degrades to 0 when the request throws (e.g. 409 on an empty repo)", async () => {
    const rest = {
      request: async () => {
        throw Object.assign(new Error("Git Repository is empty."), { status: 409 });
      },
    } as unknown as GitHubClient;
    expect(await countRepoCommits(rest, repo())).toBe(0);
  });
});
