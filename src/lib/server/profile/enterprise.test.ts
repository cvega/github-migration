/**
 * Tests for enterprise organization enumeration. The `gql` client is a queued
 * double (one response per page), so these exercise the cursor pagination, the
 * null-node filtering, and the unreadable-enterprise error without a network.
 */
import { describe, expect, test } from "bun:test";
import type { graphql } from "@octokit/graphql";
import { discoverEnterpriseOrgs } from "./enterprise";

/**
 * A `gql` double that returns each queued page in turn and records the variables
 * it was called with (so the cursor threading can be asserted).
 */
function mockGql(pages: unknown[]) {
  const calls: Array<Record<string, unknown>> = [];
  let next = 0;
  const fn = (async (_query: string, vars: Record<string, unknown>) => {
    calls.push(vars);
    const page = pages[next++];
    if (page === undefined) throw new Error("mockGql: no more pages queued");
    return page;
  }) as unknown as typeof graphql;
  return { fn, calls };
}

function page(logins: Array<string | null>, hasNextPage = false, endCursor: string | null = null) {
  return {
    enterprise: {
      organizations: {
        pageInfo: { hasNextPage, endCursor },
        nodes: logins.map((login) => (login === null ? null : { login })),
      },
    },
  };
}

describe("discoverEnterpriseOrgs", () => {
  test("returns every org login from a single page", async () => {
    const { fn, calls } = mockGql([page(["alpha", "beta", "gamma"])]);
    expect(await discoverEnterpriseOrgs(fn, "acme-inc")).toEqual(["alpha", "beta", "gamma"]);
    // First page is requested with a null cursor and the given slug.
    expect(calls).toEqual([{ slug: "acme-inc", cursor: null }]);
  });

  test("pages through the connection using the cursor", async () => {
    const { fn, calls } = mockGql([
      page(["a", "b"], true, "CURSOR1"),
      page(["c", "d"], true, "CURSOR2"),
      page(["e"]),
    ]);
    expect(await discoverEnterpriseOrgs(fn, "acme")).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls).toEqual([
      { slug: "acme", cursor: null },
      { slug: "acme", cursor: "CURSOR1" },
      { slug: "acme", cursor: "CURSOR2" },
    ]);
  });

  test("skips null nodes (orgs the viewer can't see)", async () => {
    const { fn } = mockGql([page(["a", null, "b"])]);
    expect(await discoverEnterpriseOrgs(fn, "acme")).toEqual(["a", "b"]);
  });

  test("stops paging when hasNextPage is true but the cursor is null", async () => {
    // A defensive guard: a malformed page that claims more but gives no cursor.
    const { fn, calls } = mockGql([page(["a"], true, null)]);
    expect(await discoverEnterpriseOrgs(fn, "acme")).toEqual(["a"]);
    expect(calls).toHaveLength(1);
  });

  test("returns an empty list for an enterprise with no orgs", async () => {
    const { fn } = mockGql([page([])]);
    expect(await discoverEnterpriseOrgs(fn, "acme")).toEqual([]);
  });

  test("throws when the enterprise is unreadable (null enterprise)", async () => {
    const { fn } = mockGql([{ enterprise: null }]);
    await expect(discoverEnterpriseOrgs(fn, "ghost")).rejects.toThrow(
      "Enterprise 'ghost' not found or not accessible",
    );
  });
});
