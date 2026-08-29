import type { GitHubClient } from "$lib/server/core/github";

export async function getOrgRulesetCount(rest: GitHubClient, org: string): Promise<number> {
  try {
    const response = await rest.request("GET /orgs/{org}/rulesets", { org, per_page: 100 });
    return Array.isArray(response.data) ? response.data.length : 0;
  } catch {
    return 0;
  }
}
