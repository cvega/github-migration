/**
 * Tests for the org discovery crawl. The GraphQL client is injected, so these
 * exercise the real orchestration — pagination, cursor threading, mapping, and
 * progress — against in-memory page fixtures with no network.
 */
import { describe, expect, test } from "bun:test";
import type { graphql } from "@octokit/graphql";
import { discoverOrgRepos } from "./discover";
import type { DiscoveryProgress } from "./types";

interface RepoNode {
  name: string;
  nameWithOwner: string;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  isArchived: boolean;
  isFork: boolean;
  isEmpty: boolean;
  diskUsage: number | null;
  hasWikiEnabled: boolean;
  hasIssuesEnabled: boolean;
  hasProjectsEnabled: boolean;
  hasDiscussionsEnabled: boolean;
  defaultBranchRef: { name: string } | null;
  pushedAt: string | null;
  updatedAt: string | null;
}

/** Build a repo node, overriding only the fields a test cares about. */
function node(name: string, over: Partial<RepoNode> = {}): RepoNode {
  return {
    name,
    nameWithOwner: `acme/${name}`,
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsage: 100,
    hasWikiEnabled: false,
    hasIssuesEnabled: true,
    hasProjectsEnabled: false,
    hasDiscussionsEnabled: false,
    defaultBranchRef: { name: "main" },
    pushedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...over,
  };
}

/** One discovery page's worth of GraphQL response. */
function page(
  nodes: RepoNode[],
  opts: { total: number; hasNextPage?: boolean; endCursor?: string | null },
) {
  return {
    organization: {
      repositories: {
        totalCount: opts.total,
        pageInfo: {
          hasNextPage: opts.hasNextPage ?? false,
          endCursor: opts.endCursor ?? null,
        },
        nodes,
      },
    },
  };
}

/**
 * A `gql` test double: returns each queued response in turn and records the
 * variables it was called with (to assert cursor threading).
 */
function mockGql(responses: unknown[]) {
  const calls: Array<{ login: string; cursor: string | null; pageSize: number }> = [];
  let i = 0;
  const fn = (async (_query: string, vars: Record<string, unknown>) => {
    calls.push({
      login: vars.login as string,
      cursor: (vars.cursor as string | null) ?? null,
      pageSize: vars.pageSize as number,
    });
    return responses[i++];
  }) as unknown as typeof graphql;
  return { fn, calls };
}

describe("discoverOrgRepos", () => {
  test("collects a single page and reports the org total", async () => {
    const { fn } = mockGql([page([node("alpha"), node("beta")], { total: 2 })]);

    const result = await discoverOrgRepos(fn, "acme");

    expect(result.org).toBe("acme");
    expect(result.total).toBe(2);
    expect(result.repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
  });

  test("pages through results, threading the cursor forward", async () => {
    const { fn, calls } = mockGql([
      page([node("a"), node("b")], { total: 3, hasNextPage: true, endCursor: "CUR1" }),
      page([node("c")], { total: 3, hasNextPage: false }),
    ]);

    const result = await discoverOrgRepos(fn, "acme");

    expect(result.repos.map((r) => r.name)).toEqual(["a", "b", "c"]);
    // First call has no cursor; second resumes from the first page's endCursor.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cursor).toBeNull();
    expect(calls[1]?.cursor).toBe("CUR1");
  });

  test("invokes the progress callback once per page with running totals", async () => {
    const { fn } = mockGql([
      page([node("a"), node("b")], { total: 3, hasNextPage: true, endCursor: "CUR1" }),
      page([node("c")], { total: 3, hasNextPage: false }),
    ]);
    const progress: DiscoveryProgress[] = [];

    await discoverOrgRepos(fn, "acme", (p) => progress.push(p));

    expect(progress).toEqual([
      { org: "acme", discovered: 2, total: 3, page: 1 },
      { org: "acme", discovered: 3, total: 3, page: 2 },
    ]);
  });

  test("maps GraphQL fields, including null diskUsage and a missing default branch", async () => {
    const { fn } = mockGql([
      page(
        [
          node("empty-repo", {
            visibility: "INTERNAL",
            isArchived: true,
            isEmpty: true,
            diskUsage: null,
            defaultBranchRef: null,
            hasWikiEnabled: true,
            hasDiscussionsEnabled: true,
            pushedAt: null,
          }),
        ],
        { total: 1 },
      ),
    ]);

    const [repo] = (await discoverOrgRepos(fn, "acme")).repos;

    expect(repo).toEqual({
      name: "empty-repo",
      nameWithOwner: "acme/empty-repo",
      visibility: "INTERNAL",
      isArchived: true,
      isFork: false,
      isEmpty: true,
      diskUsageKb: null,
      hasWiki: true,
      hasIssues: true,
      hasProjects: false,
      hasDiscussions: true,
      defaultBranch: null,
      pushedAt: null,
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });

  test("handles an organization with no repositories", async () => {
    const { fn } = mockGql([page([], { total: 0 })]);

    const result = await discoverOrgRepos(fn, "empty-org");

    expect(result.total).toBe(0);
    expect(result.repos).toEqual([]);
  });

  test("throws when the organization is missing or inaccessible", async () => {
    const { fn } = mockGql([{ organization: null }]);

    await expect(discoverOrgRepos(fn, "ghost")).rejects.toThrow(/not found or not accessible/i);
  });

  test("stops if a page claims another page but does not advance the cursor", async () => {
    // hasNextPage is true forever, but endCursor never changes — the guard must
    // break the loop instead of looping forever.
    const stuck = page([node("a")], { total: 5, hasNextPage: true, endCursor: null });
    const { fn, calls } = mockGql([stuck, stuck, stuck]);

    const result = await discoverOrgRepos(fn, "acme");

    expect(calls).toHaveLength(1);
    expect(result.repos.map((r) => r.name)).toEqual(["a"]);
  });
});
