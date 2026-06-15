/**
 * Per-repo commit counts — gathered via REST, not GraphQL.
 *
 * A repo's commit count is its default branch's history length. GraphQL exposes
 * it as `history.totalCount`, but that walks the entire commit graph and is the
 * field most likely to trip GitHub's ~10s query timeout at org scale. The REST
 * commits endpoint, by contrast, paginates — so requesting one commit per page
 * and reading the `Link` header's `rel="last"` page number yields the exact
 * count in a single cheap request (see `countByPagination`).
 *
 * The `rest` client is injected so this is unit-testable without a network.
 */
import { countByPagination, type GitHubClient } from "$lib/server/core/github";
import type { DiscoveredRepo } from "./types";

/**
 * Count commits on a repository's default branch via the REST `Link` header.
 *
 * Empty repos and repos without a default branch are 0 with no request. Any
 * error (e.g. a 409 on an empty repo, or a permission issue) also degrades to 0
 * so one repo can't fail the crawl — commit count is scale decoration, not a
 * blocker signal.
 *
 * @param rest Authenticated source REST client.
 * @param r    The discovered repo (provides `nameWithOwner` and `defaultBranch`).
 * @returns The default-branch commit count, or 0 when unavailable.
 */
export async function countRepoCommits(rest: GitHubClient, r: DiscoveredRepo): Promise<number> {
  if (r.isEmpty || !r.defaultBranch) return 0;
  const slash = r.nameWithOwner.indexOf("/");
  if (slash <= 0) return 0;
  const owner = r.nameWithOwner.slice(0, slash);
  const repo = r.nameWithOwner.slice(slash + 1);
  try {
    return await countByPagination(rest, "GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      sha: r.defaultBranch,
    });
  } catch {
    return 0;
  }
}
