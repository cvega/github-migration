/**
 * Enterprise organization enumeration — lists every organization that belongs
 * to a GitHub enterprise so the Profiler can fan out one child org run per org.
 *
 * Uses the GraphQL `enterprise(slug:).organizations` connection, paged through
 * its `pageInfo` cursor. The source token must be able to see the enterprise for
 * the connection to resolve at all; individual organizations that forbid the
 * token (e.g. an org policy blocking classic PATs, or a fine-grained token not
 * approved for that org) come back as partial errors and are skipped, so one
 * inaccessible org never fails the whole enumeration.
 *
 * The `gql` client is injected, so the pagination is unit-testable without a
 * network or a live Octokit.
 */
import type { graphql } from "@octokit/graphql";
import { partialDataFromError } from "./graphql-errors";

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
 * @returns    Organization logins the token can access. Organizations that
 *             forbid the token are skipped (logged). Throws only if the
 *             enterprise itself can't be read (unknown slug, or the token can't
 *             see the enterprise at all).
 */
export async function discoverEnterpriseOrgs(gql: typeof graphql, slug: string): Promise<string[]> {
  const logins: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let result: OrgsPage;
    try {
      result = await gql<OrgsPage>(ENTERPRISE_ORGS_QUERY, { slug, cursor });
    } catch (err) {
      // GitHub returns a partial response when some orgs in the enterprise
      // forbid the token: the accessible orgs still come back as `data` while
      // the forbidden ones surface as `errors` (and `null` nodes). Recover the
      // partial page so those orgs are skipped instead of failing the whole
      // enumeration; re-throw only when there's no usable data (e.g. the
      // enterprise itself is inaccessible).
      const partial = partialDataFromError(err);
      if (!partial) throw err;
      console.warn(
        `[profile] enterprise '${slug}' enumeration: some organizations are not accessible to the token and were skipped — ${err instanceof Error ? err.message : String(err)}`,
      );
      result = partial as unknown as OrgsPage;
    }

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
