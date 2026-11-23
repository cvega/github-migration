import { countByPagination, type GitHubClient } from "$lib/server/core/github";
import type { RepoSignals } from "../types";

export async function countRepoCommits(
  rest: GitHubClient,
  repo: Pick<RepoSignals, "isEmpty" | "nameWithOwner" | "defaultBranch">,
): Promise<number> {
  if (repo.isEmpty) return 0;
  const slash = repo.nameWithOwner.indexOf("/");
  if (slash <= 0 || !repo.defaultBranch)
    throw new Error(`Cannot count default-branch commits for ${repo.nameWithOwner}`);
  const count = await countByPagination(rest, "GET /repos/{owner}/{repo}/commits", {
    owner: repo.nameWithOwner.slice(0, slash),
    repo: repo.nameWithOwner.slice(slash + 1),
    sha: repo.defaultBranch,
  });
  if (count <= 0) throw new Error(`No commit evidence for non-empty ${repo.nameWithOwner}`);
  return count;
}
