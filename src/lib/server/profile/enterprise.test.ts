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

  test("recovers the accessible orgs when a partial error skips forbidden ones", async () => {
    // GitHub throws a GraphqlResponseError that still carries `data`: the
    // forbidden orgs (e.g. an org policy blocking classic PATs) resolve to null
    // nodes while the accessible ones come back.
    const err = Object.assign(
      new Error(
        "Request failed due to following response errors:\n - `sumil-sandbox` forbids access via a personal access token (classic).",
      ),
      { data: page(["alpha", null, "gamma"]) },
    );
    const fn = (async () => {
      throw err;
    }) as unknown as typeof graphql;

    expect(await discoverEnterpriseOrgs(fn, "acme")).toEqual(["alpha", "gamma"]);
  });

  test("recovers a partial page mid-pagination and keeps going", async () => {
    const firstErr = Object.assign(new Error("`forbidden-1` forbids access"), {
      data: page(["alpha", null], true, "CURSOR1"),
    });
    let call = 0;
    const calls: Array<Record<string, unknown>> = [];
    const fn = (async (_query: string, vars: Record<string, unknown>) => {
      calls.push(vars);
      if (call++ === 0) throw firstErr;
      return page(["delta", null, "epsilon"]); // second page resolves cleanly
    }) as unknown as typeof graphql;

    expect(await discoverEnterpriseOrgs(fn, "acme")).toEqual(["alpha", "delta", "epsilon"]);
    // It threaded the recovered page's cursor into the next request.
    expect(calls[1]).toEqual({ slug: "acme", cursor: "CURSOR1" });
  });

  test("re-throws an error that carries no recoverable data", async () => {
    const err = new Error("HTTP 401: Bad credentials");
    const fn = (async () => {
      throw err;
    }) as unknown as typeof graphql;

    await expect(discoverEnterpriseOrgs(fn, "acme")).rejects.toThrow("Bad credentials");
  });
});
