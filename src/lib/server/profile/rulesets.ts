/**
 * Organization rulesets — gathered via REST, because the GraphQL schema does
 * not expose rulesets. Org rulesets are not migrated, and certain ones (e.g. a
 * commit-author email rule) can fail the migration outright, so the count is
 * surfaced at the run level for the preparation summary.
 *
 * Best-effort: any error (missing scope, endpoint unavailable on an older GHES,
 * network) degrades to 0 rather than failing the crawl.
 */
import type { GitHubClient } from "$lib/server/core/github";

/** Count an organization's rulesets (best-effort; 0 on any error). */
export async function getOrgRulesetCount(rest: GitHubClient, org: string): Promise<number> {
  try {
    const res = await rest.request("GET /orgs/{org}/rulesets", { org, per_page: 100 });
    return Array.isArray(res.data) ? res.data.length : 0;
  } catch {
    return 0;
  }
}
