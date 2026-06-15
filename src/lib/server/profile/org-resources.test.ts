/**
 * Tests for org-level resource gathering. The REST client is injected (a
 * `request` double keyed by route), so these exercise the total_count/array
 * extraction and the best-effort per-endpoint error handling without a network.
 */
import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "$lib/server/core/github";
import { getOrgResources } from "./org-resources";

/**
 * A REST double whose `request(route, …)` returns a per-route response. Routes
 * not in the map throw (simulating an unavailable/unauthorized endpoint). A
 * route present in `linkByRoute` also returns a `Link` header, so the teams
 * pagination count can be exercised.
 */
function restWith(
  byRoute: Record<string, unknown>,
  linkByRoute: Record<string, string> = {},
): GitHubClient {
  return {
    request: async (route: string) => {
      if (!(route in byRoute)) throw new Error(`404 ${route}`);
      const headers = route in linkByRoute ? { link: linkByRoute[route] } : {};
      return { data: byRoute[route], headers };
    },
  } as unknown as GitHubClient;
}

const ROUTES = {
  secrets: "GET /orgs/{org}/actions/secrets",
  variables: "GET /orgs/{org}/actions/variables",
  dependabot: "GET /orgs/{org}/dependabot/secrets",
  codespaces: "GET /orgs/{org}/codespaces/secrets",
  runners: "GET /orgs/{org}/actions/runners",
  schema: "GET /orgs/{org}/properties/schema",
  teams: "GET /orgs/{org}/teams",
  installations: "GET /orgs/{org}/installations",
};

describe("getOrgResources", () => {
  test("reads total_count from each list endpoint and array length from schema", async () => {
    const rest = restWith(
      {
        [ROUTES.secrets]: { total_count: 3, secrets: [] },
        [ROUTES.variables]: { total_count: 1, variables: [] },
        [ROUTES.dependabot]: { total_count: 2, secrets: [] },
        [ROUTES.codespaces]: { total_count: 4, secrets: [] },
        [ROUTES.runners]: { total_count: 6, runners: [] },
        [ROUTES.schema]: [{ property_name: "team" }, { property_name: "tier" }],
        [ROUTES.teams]: [{ slug: "core" }],
        [ROUTES.installations]: { total_count: 5, installations: [] },
      },
      // Teams paginate: the Link header's rel="last" page is the count.
      { [ROUTES.teams]: '<https://api/teams?page=8>; rel="last"' },
    );

    expect(await getOrgResources(rest, "acme")).toEqual({
      actionsSecrets: 3,
      actionsVariables: 1,
      dependabotSecrets: 2,
      codespacesSecrets: 4,
      selfHostedRunners: 6,
      customProperties: 2,
      teams: 8,
      appInstallations: 5,
    });
  });

  test("counts a single page of teams (no Link header) by array length", async () => {
    const rest = restWith({ [ROUTES.teams]: [{ slug: "a" }, { slug: "b" }] });
    expect((await getOrgResources(rest, "acme")).teams).toBe(2);
  });

  test("degrades each unavailable endpoint to 0 independently", async () => {
    // Only runners is available; everything else throws → 0.
    const rest = restWith({ [ROUTES.runners]: { total_count: 9, runners: [] } });

    expect(await getOrgResources(rest, "acme")).toEqual({
      actionsSecrets: 0,
      actionsVariables: 0,
      dependabotSecrets: 0,
      codespacesSecrets: 0,
      selfHostedRunners: 9,
      customProperties: 0,
      teams: 0,
      appInstallations: 0,
    });
  });

  test("treats a missing total_count or non-array schema as 0", async () => {
    const rest = restWith({
      [ROUTES.secrets]: { secrets: [] }, // no total_count
      [ROUTES.schema]: { message: "not an array" },
    });
    const res = await getOrgResources(rest, "acme");
    expect(res.actionsSecrets).toBe(0);
    expect(res.customProperties).toBe(0);
  });
});
