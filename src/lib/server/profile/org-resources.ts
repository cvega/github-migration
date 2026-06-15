/**
 * Organization-level resources — gathered via REST, once per run. These are
 * org-scoped (not per-repo): Actions/Dependabot/Codespaces secrets, Actions
 * variables, self-hosted runners, and custom-property definitions. None are
 * migrated, and all must be recreated on the target.
 *
 * Every call is best-effort and independent: a missing scope, an endpoint
 * unavailable on an older GHES, or a network error degrades that one count to
 * 0 rather than failing the crawl. The six calls run concurrently.
 */
import type { GitHubClient } from "$lib/server/core/github";
import { type OrgResources, ZERO_ORG_RESOURCES } from "./types";

/** Read `total_count` from a list endpoint's response (0 on any error). */
async function totalCount(call: () => Promise<{ data: unknown }>): Promise<number> {
  try {
    const { data } = await call();
    if (data && typeof data === "object" && "total_count" in data) {
      const tc = (data as { total_count: unknown }).total_count;
      return typeof tc === "number" ? tc : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Read an array endpoint's length (0 on any error). */
async function arrayLength(call: () => Promise<{ data: unknown }>): Promise<number> {
  try {
    const { data } = await call();
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Gather an organization's migration-relevant resource counts in one concurrent
 * batch. Counts only — secret *values* are never exposed by these endpoints.
 *
 * @param rest Authenticated source REST client.
 * @param org  Organization login.
 * @returns    Per-resource counts; any unavailable resource is 0.
 */
export async function getOrgResources(rest: GitHubClient, org: string): Promise<OrgResources> {
  // `per_page: 1` keeps payloads tiny — only `total_count` is read from the list
  // endpoints; the schema endpoint returns a bare array, so length is the count.
  const [
    actionsSecrets,
    actionsVariables,
    dependabotSecrets,
    codespacesSecrets,
    selfHostedRunners,
    customProperties,
  ] = await Promise.all([
    totalCount(() => rest.request("GET /orgs/{org}/actions/secrets", { org, per_page: 1 })),
    totalCount(() => rest.request("GET /orgs/{org}/actions/variables", { org, per_page: 1 })),
    totalCount(() => rest.request("GET /orgs/{org}/dependabot/secrets", { org, per_page: 1 })),
    totalCount(() => rest.request("GET /orgs/{org}/codespaces/secrets", { org, per_page: 1 })),
    totalCount(() => rest.request("GET /orgs/{org}/actions/runners", { org, per_page: 1 })),
    arrayLength(() => rest.request("GET /orgs/{org}/properties/schema", { org })),
  ]);

  return {
    ...ZERO_ORG_RESOURCES,
    actionsSecrets,
    actionsVariables,
    dependabotSecrets,
    codespacesSecrets,
    selfHostedRunners,
    customProperties,
  };
}
