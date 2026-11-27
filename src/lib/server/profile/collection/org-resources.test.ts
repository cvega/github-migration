import { expect, test } from "bun:test";
import { getOrgResources } from "./org-resources";

test("collects independent organization resource counts", async () => {
  const rest = {
    request: async (route: string) => {
      if (route.includes("properties")) return { data: [{}, {}] };
      if (route.includes("teams"))
        return {
          data: [{}],
          headers: { link: '<https://api.github.com/orgs/acme/teams?page=3>; rel="last"' },
        };
      if (route.includes("dependabot")) throw new Error("forbidden");
      return { data: { total_count: 4 } };
    },
  } as never;
  expect(await getOrgResources(rest, "acme")).toEqual({
    actionsSecrets: 4,
    actionsVariables: 4,
    dependabotSecrets: null,
    codespacesSecrets: 4,
    selfHostedRunners: 4,
    customProperties: 2,
    teams: 3,
    appInstallations: 4,
  });
});

test("distinguishes measured zero from malformed totals and lists", async () => {
  const rest = {
    request: async (route: string) => {
      if (route.endsWith("/actions/secrets")) return { data: { total_count: 0 } };
      if (route.endsWith("/actions/runners")) return { data: { total_count: -1 } };
      return { data: {} };
    },
  };
  expect(await getOrgResources(rest as never, "acme")).toMatchObject({
    actionsSecrets: 0,
    actionsVariables: null,
    selfHostedRunners: null,
    customProperties: null,
    teams: null,
  });
});
