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

/** Result of enumerating an enterprise's organizations. */
export interface EnterpriseOrgDiscovery {
  /** Logins of the organizations the token can access (and will profile). */
  orgs: string[];
  /**
   * How many organizations the token could NOT read — they came back as `null`
   * nodes (e.g. an org policy blocking classic PATs) and were skipped. Surfaced
   * so the enterprise view can explain why its org count looks short, rather
   * than silently dropping ~⅔ of a large enterprise.
   */
  inaccessible: number;
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
 * @returns    The accessible organization logins plus a count of the ones the
 *             token can't access (skipped). Organizations that forbid the token
 *             come back as null nodes and are counted as `inaccessible`. Throws
 *             only if the enterprise itself can't be read (unknown slug, or the
 *             token can't see the enterprise at all).
 */
export async function discoverEnterpriseOrgs(
  gql: typeof graphql,
  slug: string,
): Promise<EnterpriseOrgDiscovery> {
  const logins: string[] = [];
  let inaccessible = 0;
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
      // A null node is an org the token can't read (forbidden by policy). Count
      // it so the total org figure reflects the enterprise's real size.
      if (node?.login) logins.push(node.login);
      else inaccessible += 1;
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    if (!cursor) break;
  }

  if (inaccessible > 0) {
    console.warn(
      `[profile] enterprise '${slug}': ${logins.length} org(s) accessible, ${inaccessible} inaccessible to the token (skipped)`,
    );
  }
  return { orgs: logins, inaccessible };
}
