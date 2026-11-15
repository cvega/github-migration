import { describe, expect, test } from "bun:test";
import {
  createAttributionInvitation,
  listOrganizationMannequins,
  listOrganizationMembers,
} from "$lib/server/application/mannequins";
import type { GitHubClient } from "$lib/server/core/github";

function client(overrides: Partial<GitHubClient>): GitHubClient {
  return overrides as GitHubClient;
}

describe("mannequin operations", () => {
  test("lists target organization members as sorted mapping choices", async () => {
    const listMembers = async (options: Record<string, unknown>) => {
      expect(options).toEqual({
        org: "octo-target",
        filter: "all",
        role: "all",
        per_page: 100,
      });
      return {
        data: [
          { id: 2, login: "zed", avatar_url: "https://avatars.example/zed" },
          { id: 1, login: "alice", avatar_url: "https://avatars.example/alice" },
        ],
      };
    };

    await expect(
      listOrganizationMembers(client({ orgs: { listMembers } } as never), "octo-target"),
    ).resolves.toEqual([
      { id: 1, login: "alice", avatarUrl: "https://avatars.example/alice" },
      { id: 2, login: "zed", avatarUrl: "https://avatars.example/zed" },
    ]);
  });

  test("pages through an ordered organization mannequin connection", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const responses = [
      {
        organization: {
          id: "ORG",
          login: "octo-target",
          mannequins: {
            totalCount: 51,
            pageInfo: { endCursor: "cursor-1", hasNextPage: true },
            nodes: [
              {
                id: "M1",
                login: "source-alice",
                email: null,
                createdAt: "2026-01-01",
                claimant: null,
              },
            ],
          },
        },
      },
      {
        organization: {
          id: "ORG",
          login: "octo-target",
          mannequins: {
            totalCount: 51,
            pageInfo: { endCursor: null, hasNextPage: false },
            nodes: [
              {
                id: "M2",
                login: "source-zed",
                email: "zed@example.com",
                createdAt: "2026-01-02",
                claimant: null,
              },
            ],
          },
        },
      },
    ];
    const graphql = async (_query: string, variables: Record<string, unknown>) => {
      calls.push(variables);
      return responses.shift();
    };

    const result = await listOrganizationMannequins(client({ graphql } as never), "octo-target", 2);

    expect(calls).toEqual([
      { login: "octo-target", first: 50, after: null },
      { login: "octo-target", first: 50, after: "cursor-1" },
    ]);
    expect(result).toMatchObject({ page: 2, totalPages: 2, totalCount: 51 });
    expect(result.mannequins[0]?.login).toBe("source-zed");
  });

  test("checks organization membership before creating an invitation", async () => {
    const calls: string[] = [];
    const testClient = client({
      orgs: {
        get: async () => ({ data: { node_id: "ORG" } }),
        checkMembershipForUser: async () => {
          calls.push("membership");
          return { status: 204 };
        },
      },
      users: {
        getByUsername: async () => ({ data: { login: "octocat", node_id: "USER" } }),
      },
      graphql: async (_query: string, variables: Record<string, unknown>) => {
        calls.push("mutation");
        expect(variables).toEqual({ ownerId: "ORG", sourceId: "MANNEQUIN", targetId: "USER" });
        return {
          createAttributionInvitation: {
            source: { login: "source-octocat" },
            target: { login: "octocat" },
          },
        };
      },
    } as never);

    await expect(
      createAttributionInvitation(testClient, {
        organization: "octo-target",
        mannequinId: "MANNEQUIN",
        targetLogin: "octocat",
      }),
    ).resolves.toEqual({ sourceLogin: "source-octocat", targetLogin: "octocat" });
    expect(calls).toEqual(["membership", "mutation"]);
  });

  test("returns an empty page when the mannequin cursor has reached the end", async () => {
    let calls = 0;
    const graphql = async () => {
      calls += 1;
      return {
        organization: {
          id: "ORG",
          login: "octo-target",
          mannequins: {
            totalCount: 1,
            pageInfo: { endCursor: "last-cursor", hasNextPage: false },
            nodes: [{ id: "M1", login: "source-alice", claimant: null }],
          },
        },
      };
    };

    const result = await listOrganizationMannequins(client({ graphql } as never), "octo-target", 2);

    expect(calls).toBe(1);
    expect(result).toEqual({
      organization: { id: "ORG", login: "octo-target" },
      mannequins: [],
      page: 2,
      totalPages: 1,
      totalCount: 1,
    });
  });

  test("reports an inaccessible organization rather than an empty mannequin list", async () => {
    const graphql = async () => ({ organization: null });
    await expect(
      listOrganizationMannequins(client({ graphql } as never), "unavailable-org"),
    ).rejects.toThrow("Organization unavailable-org was not found.");
  });
});
