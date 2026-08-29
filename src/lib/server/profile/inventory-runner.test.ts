import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeStore, initStore } from "$lib/server/core/db";
import type { SourceNamespaceInventory, SourceProvider } from "$lib/source/types";
import { profileStore } from "./database/schema";
import { runBitbucketInventoryProfile, runGitLabInventoryProfile } from "./inventory-runner";

beforeEach(() => initStore(":memory:", [profileStore]));
afterEach(closeStore);

function client(apiUrl: string) {
  let calls = 3;
  return {
    apiUrl,
    getApiCalls: () => calls,
    incrementCalls: () => {
      calls += 2;
    },
  };
}

function inventory(
  provider: SourceProvider,
  sourceApiUrl: string,
  namespace: string,
): SourceNamespaceInventory {
  return {
    version: 1,
    provider,
    sourceApiUrl,
    namespace,
    projectCount: { kind: "exact", value: 0 },
    projects: [],
  };
}

describe("inventory profile runners", () => {
  test("requires route-composed provider dependencies", async () => {
    const gitlab = client("https://gitlab.example.com/api/v4");
    const bitbucket = client("https://bitbucket.example.com/rest/api/1.0");

    expect(
      runGitLabInventoryProfile(gitlab, { id: "gitlab-missing", namespace: "platform" }),
    ).rejects.toThrow("GitLab inventory runner dependencies are required");
    expect(
      runBitbucketInventoryProfile(bitbucket, {
        id: "bitbucket-missing",
        namespace: "PLATFORM",
      }),
    ).rejects.toThrow("Bitbucket inventory runner dependencies are required");
  });

  test("completes GitLab discovery and enrichment with API-call accounting", async () => {
    const sourceClient = client("https://gitlab.example.com/api/v4");
    const progress: number[] = [];
    const run = await runGitLabInventoryProfile(
      sourceClient,
      { id: "gitlab-success", namespace: "platform" },
      ({ discovered }) => progress.push(discovered),
      {
        discover: async (_client, namespace, options) => {
          sourceClient.incrementCalls();
          options.onProgress?.({
            provider: "gitlab",
            namespace,
            discovered: 0,
            page: 1,
          });
          return inventory("gitlab", sourceClient.apiUrl, namespace);
        },
        enrich: async (_client, discovered) => ({
          version: 2,
          provider: "gitlab",
          sourceApiUrl: discovered.sourceApiUrl,
          namespace: discovered.namespace,
          projects: [],
        }),
      },
    );

    expect(run).toMatchObject({
      state: "completed",
      sourceProvider: "gitlab",
      totalRepos: 0,
      profiledRepos: 0,
      apiCalls: 2,
    });
    expect(progress).toEqual([0]);
  });

  test("preserves provider API errors and rejects cross-provider GitLab results", async () => {
    const apiClient = client("https://gitlab.example.com/api/v4");
    const apiFailure = await runGitLabInventoryProfile(
      apiClient,
      { id: "gitlab-api-failure", namespace: "platform" },
      undefined,
      {
        discover: async () => {
          throw new Error("GitLab returned 403");
        },
        isApiError: (error) => error instanceof Error && error.message.includes("403"),
      },
    );
    expect(apiFailure).toMatchObject({ state: "failed", failureReason: "GitLab returned 403" });

    const invalidClient = client("https://gitlab.example.com/api/v4");
    const invalid = await runGitLabInventoryProfile(
      invalidClient,
      { id: "gitlab-invalid", namespace: "platform" },
      undefined,
      {
        discover: async (_client, namespace) =>
          inventory("bitbucket-server", invalidClient.apiUrl, namespace),
      },
    );
    expect(invalid).toMatchObject({
      state: "failed",
      failureReason: "GitLab inventory response was invalid",
    });
  });

  test("completes Bitbucket discovery and classifies generic failures", async () => {
    const successClient = client("https://bitbucket.example.com/rest/api/1.0");
    const success = await runBitbucketInventoryProfile(
      successClient,
      { id: "bitbucket-success", namespace: "PLATFORM" },
      undefined,
      {
        discover: async (_client, namespace) =>
          inventory("bitbucket-server", successClient.apiUrl, namespace),
      },
    );
    expect(success).toMatchObject({
      state: "completed",
      sourceProvider: "bitbucket-server",
      totalRepos: 0,
    });

    const failedClient = client("https://bitbucket.example.com/rest/api/1.0");
    const failed = await runBitbucketInventoryProfile(
      failedClient,
      { id: "bitbucket-failed", namespace: "PLATFORM" },
      undefined,
      {
        discover: async () => {
          throw new Error("internal detail");
        },
      },
    );
    expect(failed).toMatchObject({
      state: "failed",
      failureReason: "Bitbucket Server inventory profiling failed",
    });
  });
});
