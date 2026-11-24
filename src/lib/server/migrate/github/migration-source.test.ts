import { describe, expect, test } from "bun:test";
import type { graphql } from "@octokit/graphql";
import { createTargetClients } from "$lib/server/core/github";
import {
  abortRepositoryMigration,
  archiveRepository,
  createBitbucketMigrationSource,
  createGitHubMigrationSource,
  createGitLabMigrationSource,
  getOrgDatabaseId,
  getOrgId,
  getRepositoryMigration,
  getRepositoryNodeId,
  startRepositoryMigration,
} from "./migration-source";

function gqlMock(
  handler: (query: string, variables: Record<string, unknown>) => unknown,
): typeof graphql {
  return (async (query: string, variables: Record<string, unknown>) =>
    handler(query, variables)) as typeof graphql;
}

describe("GitHub migration GraphQL operations", () => {
  test("does not retry a target start on a lost upstream response", async () => {
    let submissions = 0;
    const gql = createTargetClients(
      { token: "fixture" },
      "https://fixture.invalid",
    ).targetGraphql.defaults({
      request: {
        fetch: async () => {
          submissions++;
          return Response.json({ message: "Upstream disconnected" }, { status: 502 });
        },
      },
    });
    await expect(
      startRepositoryMigration(gql, {
        migrationSourceId: "source",
        sourceRepoUrl: "https://source.invalid/org/repo",
        orgId: "org",
        repoName: "repo",
        sourceToken: "fixture",
        targetToken: "fixture",
        gitArchiveUrl: "",
        metadataArchiveUrl: "",
      }),
    ).rejects.toThrow();
    expect(submissions).toBe(1);
  });
  test("creates source types with the target organization owner", async () => {
    const variables: Record<string, unknown>[] = [];
    const gql = gqlMock((_query, input) => {
      variables.push(input);
      return { createMigrationSource: { migrationSource: { id: `source-${variables.length}` } } };
    });
    expect(await createGitHubMigrationSource(gql, "ORG")).toBe("source-1");
    expect(await createGitLabMigrationSource(gql, "ORG")).toBe("source-2");
    expect(await createBitbucketMigrationSource(gql, "ORG")).toBe("source-3");
    expect(variables.map((input) => input.type)).toEqual([
      "GITHUB_ARCHIVE",
      "GITLAB",
      "BITBUCKET_SERVER",
    ]);
    expect(variables.every((input) => input.ownerId === "ORG")).toBe(true);
  });

  test("passes every repository migration option with explicit defaults", async () => {
    let variables: Record<string, unknown> = {};
    const gql = gqlMock((_query, input) => {
      variables = input;
      return { startRepositoryMigration: { repositoryMigration: { id: "migration-node" } } };
    });
    expect(
      await startRepositoryMigration(gql, {
        migrationSourceId: "source",
        sourceRepoUrl: "https://github.example/acme/widget",
        orgId: "org",
        repoName: "widget",
        sourceToken: "source-token",
        targetToken: "target-token",
        gitArchiveUrl: "",
        metadataArchiveUrl: "https://archives.example/metadata",
      }),
    ).toBe("migration-node");
    expect(variables).toMatchObject({
      continueOnError: true,
      gitArchiveUrl: null,
      skipReleases: false,
      targetRepoVisibility: null,
      lockSource: false,
    });
  });

  test("queries organization and repository identities", async () => {
    const gql = gqlMock((query) => {
      if (query.includes("databaseId")) return { organization: { databaseId: 42 } };
      if (query.includes("organization")) return { organization: { id: "ORG" } };
      return { repository: { id: "REPO" } };
    });
    expect(await getOrgId(gql, "acme")).toBe("ORG");
    expect(await getOrgDatabaseId(gql, "acme")).toBe("42");
    expect(await getRepositoryNodeId(gql, "acme", "widget")).toBe("REPO");
  });

  test("gets, aborts, and archives repository migrations", async () => {
    const status = {
      state: "IN_PROGRESS",
      repositoryName: "widget",
      warningsCount: 0,
      failureReason: "",
      migrationLogUrl: "",
    };
    const gql = gqlMock((query) => {
      if (query.includes("abortRepositoryMigration")) {
        return { abortRepositoryMigration: { success: true } };
      }
      if (query.includes("archiveRepository")) {
        return { archiveRepository: { repository: { isArchived: true } } };
      }
      return { node: status };
    });
    expect(await getRepositoryMigration(gql, "migration")).toBe(status);
    expect(await abortRepositoryMigration(gql, "migration")).toBe(true);
    expect(await archiveRepository(gql, "repo")).toBe(true);
  });
});
