import { resolveTargetAuth } from "$lib/server/core/auth";
import type { GitHubClient } from "$lib/server/core/github";
import { createSingleClient } from "$lib/server/core/github";

const MANNEQUINS_PER_PAGE = 50;

interface MannequinClaimant {
  id: string;
  login: string;
  avatarUrl: string;
}

interface Mannequin {
  id: string;
  login: string;
  email: string | null;
  createdAt: string;
  claimant: MannequinClaimant | null;
}

export interface TargetMember {
  id: number;
  login: string;
  avatarUrl: string;
}

export interface MannequinPage {
  organization: {
    id: string;
    login: string;
  };
  mannequins: Mannequin[];
  totalCount: number;
  page: number;
  totalPages: number;
}

interface MannequinQueryResult {
  organization: {
    id: string;
    login: string;
    mannequins: {
      totalCount: number;
      pageInfo: {
        endCursor: string | null;
        hasNextPage: boolean;
      };
      nodes: Mannequin[];
    };
  } | null;
}

const MANNEQUINS_QUERY = `
  query OrganizationMannequins($login: String!, $first: Int!, $after: String) {
    organization(login: $login) {
      id
      login
      mannequins(
        first: $first
        after: $after
        orderBy: { field: LOGIN, direction: ASC }
      ) {
        totalCount
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          id
          login
          email
          createdAt
          claimant {
            id
            login
            avatarUrl(size: 40)
          }
        }
      }
    }
  }
`;

const CREATE_INVITATION_MUTATION = `
  mutation CreateAttributionInvitation($ownerId: ID!, $sourceId: ID!, $targetId: ID!) {
    createAttributionInvitation(
      input: { ownerId: $ownerId, sourceId: $sourceId, targetId: $targetId }
    ) {
      source {
        ... on Mannequin {
          id
          login
        }
      }
      target {
        ... on User {
          id
          login
        }
      }
    }
  }
`;

export function getTargetMannequinClient(): GitHubClient {
  return createSingleClient(resolveTargetAuth(), "https://api.github.com");
}

export async function listOrganizationMembers(
  client: GitHubClient,
  organization: string,
): Promise<TargetMember[]> {
  const { data: members } = await client.orgs.listMembers({
    org: organization,
    filter: "all",
    role: "all",
    per_page: 100,
  });

  return members
    .map((member) => ({ id: member.id, login: member.login, avatarUrl: member.avatar_url }))
    .sort((left, right) => left.login.localeCompare(right.login));
}

export async function listOrganizationMannequins(
  client: GitHubClient,
  organization: string,
  requestedPage = 1,
): Promise<MannequinPage> {
  const page = Math.max(1, requestedPage);
  let cursor: string | null = null;
  let result: MannequinQueryResult | null = null;

  for (let currentPage = 1; currentPage <= page; currentPage += 1) {
    result = (await client.graphql(MANNEQUINS_QUERY, {
      login: organization,
      first: MANNEQUINS_PER_PAGE,
      after: cursor,
    })) as MannequinQueryResult;

    if (!result.organization) throw new Error(`Organization ${organization} was not found.`);
    if (currentPage === page) break;
    if (!result.organization.mannequins.pageInfo.hasNextPage) {
      return {
        organization: { id: result.organization.id, login: result.organization.login },
        mannequins: [],
        totalCount: result.organization.mannequins.totalCount,
        page,
        totalPages: Math.max(
          1,
          Math.ceil(result.organization.mannequins.totalCount / MANNEQUINS_PER_PAGE),
        ),
      };
    }
    cursor = result.organization.mannequins.pageInfo.endCursor;
  }

  if (!result?.organization) throw new Error(`Organization ${organization} was not found.`);
  const { mannequins } = result.organization;
  return {
    organization: { id: result.organization.id, login: result.organization.login },
    mannequins: mannequins.nodes,
    totalCount: mannequins.totalCount,
    page,
    totalPages: Math.max(1, Math.ceil(mannequins.totalCount / MANNEQUINS_PER_PAGE)),
  };
}

export async function createAttributionInvitation(
  client: GitHubClient,
  input: { organization: string; mannequinId: string; targetLogin: string },
): Promise<{ sourceLogin: string; targetLogin: string }> {
  const [{ data: organization }, { data: target }] = await Promise.all([
    client.orgs.get({ org: input.organization }),
    client.users.getByUsername({ username: input.targetLogin }),
  ]);

  await client.orgs.checkMembershipForUser({
    org: input.organization,
    username: target.login,
  });

  const result = (await client.graphql(CREATE_INVITATION_MUTATION, {
    ownerId: organization.node_id,
    sourceId: input.mannequinId,
    targetId: target.node_id,
  })) as {
    createAttributionInvitation: {
      source: { login: string };
      target: { login: string };
    };
  };

  return {
    sourceLogin: result.createAttributionInvitation.source.login,
    targetLogin: result.createAttributionInvitation.target.login,
  };
}
