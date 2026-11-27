import type { GitHubClient } from "$lib/server/core/github";
import { paginatedCount } from "./org-resources";

export function getOrgRulesetCount(rest: GitHubClient, org: string): Promise<number | null> {
  return paginatedCount(rest, "GET /orgs/{org}/rulesets", org);
}
