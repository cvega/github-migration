/**
 * Source discovery — the Profiler's bulk, breadth-first crawl.
 *
 * Lists every repository in an organization via the REST `GET /orgs/{org}/repos`
 * endpoint (the `minimal-repository` shape), paged through the `Link` header.
 * REST listing is the reliable primitive for "give me the repos": it's an
 * indexed, paginated read that never hits GraphQL's ~10s query timeout (which a
 * 100-wide GraphQL page carrying several connection `totalCount`s can tip over
 * on a large org). The per-repo indexed counts (issues, PRs, branches, tags,
 * releases, …) are gathered afterwards by the batched GraphQL counts pass, where
 * a too-expensive chunk degrades a repo to zeros instead of failing the list.
 *
 * The `rest` client is injected, so this orchestration — pagination, mapping,
 * progress — is unit-testable without a network or a live Octokit.
 */
import type { GitHubClient } from "$lib/server/core/github";
import type { DiscoveredRepo, DiscoveryProgress, OrgDiscovery, RepoVisibility } from "./types";

/** REST caps `per_page` at 100. */
const REPOS_PER_PAGE = 100;

/**
 * The subset of `minimal-repository` (the `GET /orgs/{org}/repos` item) that the
 * discovery spine reads. The real Octokit type is a superset, so it's assignable
 * to this; everything but the identity fields is optional, matching the schema.
 */
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
  default_branch?: string;
  pushed_at?: string | null;
  updated_at?: string | null;
}

/** Normalize a REST visibility (`"public"`) to the GraphQL enum (`"PUBLIC"`). */
function toVisibility(repo: RestRepoSummary): RepoVisibility {
  const raw = repo.visibility ?? (repo.private ? "private" : "public");
  return raw.toUpperCase() as RepoVisibility;
}

/** Map a REST `minimal-repository` to the discovery-facing spine. */
function toDiscoveredRepo(repo: RestRepoSummary): DiscoveredRepo {
  return {
    name: repo.name,
    nameWithOwner: repo.full_name,
    visibility: toVisibility(repo),
    isArchived: repo.archived ?? false,
    isFork: repo.fork,
    // REST has no `is_empty`; a freshly-created repo with no commits reports
    // size 0, so it's a sound proxy for the "· empty" display badge.
    isEmpty: (repo.size ?? 0) === 0,
    diskUsageKb: repo.size ?? null,
    hasWiki: repo.has_wiki ?? false,
    hasIssues: repo.has_issues ?? false,
    hasProjects: repo.has_projects ?? false,
    hasDiscussions: repo.has_discussions ?? false,
    defaultBranch: repo.default_branch ?? null,
    pushedAt: repo.pushed_at ?? null,
    updatedAt: repo.updated_at ?? null,
  };
}

/**
 * Discover every repository in an organization via the paged REST listing.
 *
 * @param rest       Injected REST client (`getSourceClients().rest`).
 * @param org        Organization login to crawl.
 * @param onProgress Optional callback invoked once per page with running totals.
 *                   REST doesn't report an org total up front, so `total` tracks
 *                   the running count and lands on the exact figure on the last
 *                   page.
 * @returns          The org's repository total and the full `DiscoveredRepo[]`.
 */
export async function discoverOrgRepos(
  rest: GitHubClient,
  org: string,
  onProgress?: (progress: DiscoveryProgress) => void,
): Promise<OrgDiscovery> {
  const repos: DiscoveredRepo[] = [];
  let page = 0;

  const iterator = rest.paginate.iterator(rest.repos.listForOrg, {
    org,
    per_page: REPOS_PER_PAGE,
    type: "all",
    sort: "full_name",
    direction: "asc",
  });

  for await (const response of iterator) {
    page += 1;
    for (const repo of response.data) {
      repos.push(toDiscoveredRepo(repo));
    }
    onProgress?.({ org, discovered: repos.length, total: repos.length, page });
  }

  return { org, total: repos.length, repos };
}
