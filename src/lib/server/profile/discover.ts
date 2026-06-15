/**
 * Source discovery — the Profiler's bulk, breadth-first crawl.
 *
 * Pages a single GraphQL query over an organization's repositories and maps
 * each node to a `DiscoveredRepo`. The `gql` client is injected (the same
 * `typeof graphql` the rest of github.ts passes around) so this orchestration —
 * pagination, cursor threading, mapping, progress — is unit-testable without a
 * network or a live Octokit.
 */
import type { graphql } from "@octokit/graphql";
import { isTimeoutError } from "./graphql-errors";
import type { DiscoveredRepo, DiscoveryProgress, OrgDiscovery, RepoVisibility } from "./types";

/** GraphQL caps `repositories(first:)` at 100. */
const REPOS_PER_PAGE = 100;

/** Smallest discovery page we'll shrink to before surfacing a timeout. A page
 *  of only indexed counts should never time out this small; if it does, the
 *  error is real and worth surfacing rather than retrying forever. */
const MIN_PAGE_SIZE = 10;

/** Raw shape of one repository node in the discovery query. */
interface RepoNode {
  name: string;
  nameWithOwner: string;
  visibility: RepoVisibility;
  isArchived: boolean;
  isFork: boolean;
  isEmpty: boolean;
  diskUsage: number | null;
  hasWikiEnabled: boolean;
  hasIssuesEnabled: boolean;
  hasProjectsEnabled: boolean;
  hasDiscussionsEnabled: boolean;
  defaultBranchRef: { name: string } | null;
  pushedAt: string | null;
  updatedAt: string | null;
  issues: { totalCount: number };
  pullRequests: { totalCount: number };
  branches: { totalCount: number };
  tags: { totalCount: number };
  releases: { totalCount: number };
}

/** Raw shape of the paged discovery query response. */
interface OrgReposResult {
  organization: {
    repositories: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RepoNode[];
    };
  } | null;
}

const ORG_REPOS_QUERY = `query orgRepos($login: String!, $cursor: String, $pageSize: Int!) {
  organization(login: $login) {
    repositories(first: $pageSize, after: $cursor, orderBy: { field: NAME, direction: ASC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        nameWithOwner
        visibility
        isArchived
        isFork
        isEmpty
        diskUsage
        hasWikiEnabled
        hasIssuesEnabled
        hasProjectsEnabled
        hasDiscussionsEnabled
        defaultBranchRef { name }
        pushedAt
        updatedAt
        issues { totalCount }
        pullRequests { totalCount }
        branches: refs(refPrefix: "refs/heads/", first: 1) { totalCount }
        tags: refs(refPrefix: "refs/tags/", first: 1) { totalCount }
        releases { totalCount }
      }
    }
  }
}`;

/** Map a raw GraphQL node to the discovery-facing shape. */
function toDiscoveredRepo(node: RepoNode): DiscoveredRepo {
  return {
    name: node.name,
    nameWithOwner: node.nameWithOwner,
    visibility: node.visibility,
    isArchived: node.isArchived,
    isFork: node.isFork,
    isEmpty: node.isEmpty,
    diskUsageKb: node.diskUsage,
    hasWiki: node.hasWikiEnabled,
    hasIssues: node.hasIssuesEnabled,
    hasProjects: node.hasProjectsEnabled,
    hasDiscussions: node.hasDiscussionsEnabled,
    defaultBranch: node.defaultBranchRef?.name ?? null,
    pushedAt: node.pushedAt,
    updatedAt: node.updatedAt,
    issuesCount: node.issues.totalCount,
    pullRequestsCount: node.pullRequests.totalCount,
    branchesCount: node.branches.totalCount,
    tagsCount: node.tags.totalCount,
    releasesCount: node.releases.totalCount,
  };
}

/**
 * Fetch one discovery page, halving the page size and retrying the *same*
 * cursor each time GitHub times the request out (502/504), down to
 * `MIN_PAGE_SIZE`. A 100-wide page of indexed counts is normally cheap, but an
 * org with repos that have very many refs/issues can tip one page over GitHub's
 * ~10s limit; shrinking keeps discovery — the only thing between the user and "a
 * list of repos" — completing instead of failing the whole run. Returns the page
 * plus the size that actually worked so the caller can keep using it for the
 * remaining pages rather than re-hitting the timeout on every one.
 */
async function fetchPageAdaptive(
  gql: typeof graphql,
  org: string,
  cursor: string | null,
  pageSize: number,
): Promise<{ result: OrgReposResult; pageSize: number }> {
  let size = pageSize;
  for (;;) {
    try {
      const result = await gql<OrgReposResult>(ORG_REPOS_QUERY, {
        login: org,
        cursor,
        pageSize: size,
      });
      return { result, pageSize: size };
    } catch (err) {
      if (isTimeoutError(err) && size > MIN_PAGE_SIZE) {
        const smaller = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
        console.warn(
          `[profile] discovery page of ${size} timed out for '${org}'; retrying this page at ${smaller}`,
        );
        size = smaller;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Discover every repository in an organization via paged GraphQL.
 *
 * @param gql        Injected GraphQL client (`createSingleClient(...).graphql`).
 * @param org        Organization login to crawl.
 * @param onProgress Optional callback invoked once per page with running totals.
 * @returns          The org's repository total and the full `DiscoveredRepo[]`.
 * @throws           If the organization is missing or not accessible.
 */
export async function discoverOrgRepos(
  gql: typeof graphql,
  org: string,
  onProgress?: (progress: DiscoveryProgress) => void,
): Promise<OrgDiscovery> {
  const repos: DiscoveredRepo[] = [];
  let cursor: string | null = null;
  let total = 0;
  let page = 0;
  // Adaptive page size: starts at the 100-wide max and only shrinks (and stays
  // shrunk) if a page times out, so small orgs pay nothing for the resilience.
  let pageSize = REPOS_PER_PAGE;

  for (;;) {
    const { result, pageSize: usedSize } = await fetchPageAdaptive(gql, org, cursor, pageSize);
    pageSize = usedSize;

    const connection = result.organization?.repositories;
    if (!connection) {
      throw new Error(`Organization '${org}' not found or not accessible`);
    }

    total = connection.totalCount;
    page += 1;
    for (const node of connection.nodes) {
      repos.push(toDiscoveredRepo(node));
    }

    onProgress?.({ org, discovered: repos.length, total, page });

    // Stop at the last page. The cursor-advance guard also breaks the loop if a
    // response claims another page but doesn't actually move the cursor forward,
    // so a malformed `pageInfo` can never spin forever.
    const { hasNextPage, endCursor } = connection.pageInfo;
    if (!hasNextPage || !endCursor || endCursor === cursor) {
      break;
    }
    cursor = endCursor;
  }

  return { org, total, repos };
}
