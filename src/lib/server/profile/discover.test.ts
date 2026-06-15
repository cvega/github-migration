/**
 * Tests for the org discovery crawl. The REST client is injected, so these
 * exercise the real orchestration — pagination, mapping (REST → spine), and
 * progress — against in-memory page fixtures with no network.
 */
import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "$lib/server/core/github";
import { discoverOrgRepos } from "./discover";
import type { DiscoveryProgress } from "./types";

/** The subset of a REST `minimal-repository` the discovery mapper reads. */
interface RestRepo {
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  visibility?: string;
  archived?: boolean;
  size?: number;
  has_wiki?: boolean;
  has_issues?: boolean;
  has_projects?: boolean;
  has_discussions?: boolean;
  default_branch?: string;
  pushed_at?: string | null;
  updated_at?: string | null;
}

/** Build a REST repo item, overriding only the fields a test cares about. */
function repo(name: string, over: Partial<RestRepo> = {}): RestRepo {
  return {
    name,
    full_name: `acme/${name}`,
    private: true,
    fork: false,
    visibility: "private",
    archived: false,
    size: 100,
    has_wiki: false,
    has_issues: true,
    has_projects: false,
    has_discussions: false,
    default_branch: "main",
    pushed_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...over,
  };
}

/**
 * A `rest` test double whose `paginate.iterator` yields the queued pages and
 * records the options it was called with (to assert the request shape). Mirrors
 * the Octokit surface `discoverOrgRepos` uses: `rest.paginate.iterator(
 * rest.repos.listForOrg, opts)`.
 */
function mockRest(pages: RestRepo[][]) {
  const calls: Array<Record<string, unknown>> = [];
  const rest = {
    repos: { listForOrg: () => undefined },
    paginate: {
      iterator: (_route: unknown, opts: Record<string, unknown>) => {
        calls.push(opts);
        return (async function* () {
          for (const data of pages) yield { data };
        })();
      },
    },
  } as unknown as GitHubClient;
  return { rest, calls };
}

describe("discoverOrgRepos", () => {
  test("collects a single page and reports the running total", async () => {
    const { rest } = mockRest([[repo("alpha"), repo("beta")]]);

    const result = await discoverOrgRepos(rest, "acme");

    expect(result.org).toBe("acme");
    expect(result.total).toBe(2);
    expect(result.repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
  });

  test("concatenates repos across pages", async () => {
    const { rest } = mockRest([[repo("a"), repo("b")], [repo("c")]]);

    const result = await discoverOrgRepos(rest, "acme");

    expect(result.repos.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(result.total).toBe(3);
  });

  test("invokes the progress callback once per page with running totals", async () => {
    const { rest } = mockRest([[repo("a"), repo("b")], [repo("c")]]);
    const progress: DiscoveryProgress[] = [];

    await discoverOrgRepos(rest, "acme", (p) => progress.push(p));

    expect(progress).toEqual([
      { org: "acme", discovered: 2, total: 2, page: 1 },
      { org: "acme", discovered: 3, total: 3, page: 2 },
    ]);
  });

  test("requests every repo type, 100 per page, sorted by name", async () => {
    const { rest, calls } = mockRest([[repo("a")]]);

    await discoverOrgRepos(rest, "acme");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      org: "acme",
      per_page: 100,
      type: "all",
      sort: "full_name",
      direction: "asc",
    });
  });

  test("maps REST fields, normalizing visibility and proxying empty via size", async () => {
    const { rest } = mockRest([
      [
        repo("empty-repo", {
          visibility: "internal",
          archived: true,
          size: 0,
          default_branch: undefined,
          has_wiki: true,
          has_discussions: true,
          pushed_at: null,
        }),
      ],
    ]);

    const [mapped] = (await discoverOrgRepos(rest, "acme")).repos;

    expect(mapped).toEqual({
      name: "empty-repo",
      nameWithOwner: "acme/empty-repo",
      visibility: "INTERNAL",
      isArchived: true,
      isFork: false,
      isEmpty: true, // size 0 → empty proxy
      diskUsageKb: 0,
      hasWiki: true,
      hasIssues: true,
      hasProjects: false,
      hasDiscussions: true,
      defaultBranch: null,
      pushedAt: null,
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });

  test("derives visibility from `private` when the field is absent", async () => {
    const { rest } = mockRest([
      [
        repo("pub", { visibility: undefined, private: false }),
        repo("prv", { visibility: undefined, private: true }),
      ],
    ]);

    const repos = (await discoverOrgRepos(rest, "acme")).repos;

    expect(repos.map((r) => r.visibility)).toEqual(["PUBLIC", "PRIVATE"]);
  });

  test("treats a non-zero size as non-empty", async () => {
    const { rest } = mockRest([[repo("busy", { size: 4096 })]]);

    const [mapped] = (await discoverOrgRepos(rest, "acme")).repos;

    expect(mapped?.isEmpty).toBe(false);
    expect(mapped?.diskUsageKb).toBe(4096);
  });

  test("handles an organization with no repositories", async () => {
    const { rest } = mockRest([]);

    const result = await discoverOrgRepos(rest, "empty-org");

    expect(result.total).toBe(0);
    expect(result.repos).toEqual([]);
  });
});
