import { env } from "node:process";
import type { MigrationTargetProfile } from "$lib/migration-target";
import { isTargetAuthAvailable } from "$lib/server/core/auth";
import { recordOperatorAuditEvent } from "$lib/server/core/auth/audit";
import type { GitHubClient } from "$lib/server/core/github";
import {
  beginIdentityInvitation,
  markIdentityInvitationSent,
  rejectIdentityInvitation,
} from "$lib/server/migrate/database/identity-mappings";

export {
  getMigrationTargetClient as getTargetMannequinClient,
  migrationTargetCredentialError as mannequinTargetCredentialError,
} from "$lib/server/core/targets";

const MANNEQUINS_PER_PAGE = 50;

interface MannequinClaimant {
  id: string;
  login: string;
  avatarUrl: string;
}

export interface Mannequin {
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

export function isMannequinTargetAuthAvailable(target: MigrationTargetProfile): boolean {
  return target.platform === "ghec"
    ? isTargetAuthAvailable()
    : Boolean(env.GHES_TARGET_ADMIN_PAT?.trim());
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

export async function listAllOrganizationMannequins(
  client: GitHubClient,
  organization: string,
): Promise<Mannequin[]> {
  const mannequins: Mannequin[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = (await client.graphql(MANNEQUINS_QUERY, {
      login: organization,
      first: MANNEQUINS_PER_PAGE,
      after: cursor,
    })) as MannequinQueryResult;
    if (!result.organization) throw new Error(`Organization ${organization} was not found.`);
    const connection = result.organization.mannequins;
    mannequins.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return mannequins;
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
      throw new Error("GitHub returned an invalid mannequin pagination cursor.");
    }
    cursor = connection.pageInfo.endCursor;
  }
}

export async function getTargetUserReadiness(
  client: GitHubClient,
  organization: string,
  login: string,
): Promise<"ready" | "pending" | "not_member" | "not_found"> {
  try {
    await client.users.getByUsername({ username: login });
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) return "not_found";
    throw error;
  }
  try {
    const { data } = await client.orgs.getMembershipForUser({ org: organization, username: login });
    if (data.state === "active") return "ready";
    if (data.state === "pending") return "pending";
    throw new Error(`Unexpected organization membership state: ${data.state}`);
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) return "not_member";
    throw error;
  }
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
    request: { retries: 0 },
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

export async function inviteMappedMannequin(
  client: GitHubClient,
  target: MigrationTargetProfile,
  organization: string,
  mannequinId: string,
  targetLogin: string,
  locals: App.Locals,
) {
  const mapping = {
    targetApiUrl: target.apiUrl,
    targetOrg: organization,
    sourceIdentity: mannequinId,
    targetLogin,
  };
  if (!beginIdentityInvitation(mapping))
    return { outcome: "invitation already sent or uncertain" } as const;
  let invitation: Awaited<ReturnType<typeof createAttributionInvitation>>;
  try {
    invitation = await createAttributionInvitation(client, {
      organization,
      mannequinId,
      targetLogin,
    });
  } catch (error) {
    const status = error instanceof Error && "status" in error ? Number(error.status) : null;
    if (status === 401 || status === 403 || status === 404) {
      rejectIdentityInvitation(mapping);
      return { outcome: "invitation rejected", status } as const;
    }
    console.error(
      "[mannequins] invitation outcome requires verification",
      error instanceof Error ? error.message : "unknown error",
    );
    return { outcome: "invitation outcome uncertain" } as const;
  }
  markIdentityInvitationSent(mapping);
  recordOperatorAuditEvent(locals, {
    action: "mannequin.invitation_created",
    resourceType: "mannequin",
    resourceId: mannequinId,
    metadata: { targetProfileId: target.id, organization, targetLogin: invitation.targetLogin },
  });
  return { outcome: "invitation sent", targetLogin: invitation.targetLogin } as const;
}
