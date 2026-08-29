import { countByPagination, type GitHubClient } from "$lib/server/core/github";
import { type OrgResources, ZERO_ORG_RESOURCES } from "../types";

async function totalCount(call: () => Promise<{ data: unknown }>): Promise<number> {
  try {
    const { data } = await call();
    const value =
      data && typeof data === "object" && "total_count" in data
        ? (data as { total_count: unknown }).total_count
        : 0;
    return typeof value === "number" ? value : 0;
  } catch {
    return 0;
  }
}
async function arrayLength(call: () => Promise<{ data: unknown }>): Promise<number> {
  try {
    const { data } = await call();
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}
async function paginatedCount(rest: GitHubClient, route: string, org: string): Promise<number> {
  try {
    return await countByPagination(rest, route, { org });
  } catch {
    return 0;
  }
}

export async function getOrgResources(rest: GitHubClient, org: string): Promise<OrgResources> {
  const [
    actionsSecrets,
    actionsVariables,
    dependabotSecrets,
    codespacesSecrets,
    selfHostedRunners,
    customProperties,
    teams,
    appInstallations,
  ] = await Promise.all([
    totalCount(() => rest.request("GET /orgs/{org}/actions/secrets", { org, per_page: 1 })),
    totalCount(() => rest.request("GET /orgs/{org}/actions/variables", { org, per_page: 1 })),
    totalCount(() => rest.request("GET /orgs/{org}/dependabot/secrets", { org, per_page: 1 })),
    totalCount(() => rest.request("GET /orgs/{org}/codespaces/secrets", { org, per_page: 1 })),
    totalCount(() => rest.request("GET /orgs/{org}/actions/runners", { org, per_page: 1 })),
    arrayLength(() => rest.request("GET /orgs/{org}/properties/schema", { org })),
    paginatedCount(rest, "GET /orgs/{org}/teams", org),
    totalCount(() => rest.request("GET /orgs/{org}/installations", { org, per_page: 1 })),
  ]);
  return {
    ...ZERO_ORG_RESOURCES,
    actionsSecrets,
    actionsVariables,
    dependabotSecrets,
    codespacesSecrets,
    selfHostedRunners,
    customProperties,
    teams,
    appInstallations,
  };
}
