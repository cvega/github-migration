import { countByPagination, type GitHubClient } from "$lib/server/core/github";
import type { DiscoveredRepo } from "../types";

export async function countRepoCommits(rest: GitHubClient, repo: DiscoveredRepo): Promise<number> {
  if (repo.isEmpty || !repo.defaultBranch) return 0;
  const slash = repo.nameWithOwner.indexOf("/");
  if (slash <= 0) return 0;
  try {
    return await countByPagination(rest, "GET /repos/{owner}/{repo}/commits", {
      owner: repo.nameWithOwner.slice(0, slash),
      repo: repo.nameWithOwner.slice(slash + 1),
      sha: repo.defaultBranch,
    });
  } catch {
    return 0;
  }
}
