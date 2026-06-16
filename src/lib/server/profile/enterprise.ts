/**
 * Enterprise organization enumeration — lists every organization that belongs
 * to a GitHub enterprise so the Profiler can fan out one child org run per org.
 *
 * Uses the GraphQL `enterprise(slug:).organizations` connection, paged through
 * its `pageInfo` cursor. The source token must be a member or owner of the
 * enterprise for the connection to resolve; otherwise GraphQL returns an error,
 * which the caller surfaces as the enterprise run's failure reason.
 *
 * The `gql` client is injected, so the pagination is unit-testable without a
 * network or a live Octokit.
 */
import type { graphql } from "@octokit/graphql";

/** GraphQL caps a connection page at 100. */
const ORGS_PER_PAGE = 100;

/** A safety cap so a malformed cursor loop can't page forever. */
const MAX_PAGES = 200;

/** Shape of one `enterprise.organizations` GraphQL page. */
interface OrgsPage {
  enterprise: {
    organizations: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ login: string } | null>;
    };
  } | null;
}

const ENTERPRISE_ORGS_QUERY = `
  query($slug: String!, $cursor: String) {
    enterprise(slug: $slug) {
      organizations(first: ${ORGS_PER_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { login }
      }
    }
  }
`;

/**
 * List the logins of every organization in an enterprise, in the order GitHub
 * returns them. Pages through the connection until exhausted.
 *
 * @param gql  Authenticated source GraphQL client.
 * @param slug The enterprise URL slug (not the display name).
 * @returns    Organization logins. Throws if the enterprise can't be read
 *             (unknown slug, or the token isn't an enterprise member/owner).
 */
export async function discoverEnterpriseOrgs(gql: typeof graphql, slug: string): Promise<string[]> {
  const logins: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result: OrgsPage = await gql<OrgsPage>(ENTERPRISE_ORGS_QUERY, { slug, cursor });
    const connection = result.enterprise?.organizations;
    if (!connection) {
      throw new Error(`Enterprise '${slug}' not found or not accessible`);
    }
    for (const node of connection.nodes) {
      if (node?.login) logins.push(node.login);
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    if (!cursor) break;
  }

  return logins;
}
