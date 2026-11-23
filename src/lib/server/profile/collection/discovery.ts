import type { GitHubClient } from "$lib/server/core/github";
import type { DiscoveredRepo, DiscoveryProgress, OrgDiscovery, RepoVisibility } from "../types";

interface RestRepoSummary {
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
  has_pages?: boolean;
  default_branch?: string;
  pushed_at?: string | null;
  updated_at?: string | null;
}

function discovered(repo: RestRepoSummary): DiscoveredRepo {
  if (repo.size == null || !Number.isSafeInteger(repo.size) || repo.size < 0)
    throw new Error(`Repository size unavailable for ${repo.full_name}`);
  return {
    name: repo.name,
    nameWithOwner: repo.full_name,
    visibility: (
      repo.visibility ?? (repo.private ? "private" : "public")
    ).toUpperCase() as RepoVisibility,
    isArchived: repo.archived ?? false,
    isFork: repo.fork,
    diskUsageKb: repo.size,
    hasWiki: repo.has_wiki ?? false,
    hasIssues: repo.has_issues ?? false,
    hasProjects: repo.has_projects ?? false,
    hasDiscussions: repo.has_discussions ?? false,
    hasPages: repo.has_pages ?? false,
    defaultBranch: repo.default_branch ?? null,
    pushedAt: repo.pushed_at ?? null,
    updatedAt: repo.updated_at ?? null,
  };
}

export async function discoverOrgRepos(
  rest: GitHubClient,
  org: string,
  onProgress?: (progress: DiscoveryProgress) => void,
  maxItems = 10_000,
): Promise<OrgDiscovery> {
  const repos: DiscoveredRepo[] = [];
  let page = 0;
  const iterator = rest.paginate.iterator(rest.repos.listForOrg, {
    org,
    per_page: 100,
    type: "all",
    sort: "full_name",
    direction: "asc",
  });
  for await (const response of iterator) {
    page += 1;
    if (repos.length + response.data.length > maxItems) {
      throw new Error(
        `GitHub organization inventory exceeds the supported limit of ${maxItems.toLocaleString("en-US")} repositories`,
      );
    }
    for (const repo of response.data) repos.push(discovered(repo));
    onProgress?.({ org, discovered: repos.length, total: repos.length, page });
  }
  return { org, total: repos.length, repos };
}
