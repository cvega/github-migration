import { describe, expect, test } from "bun:test";
import type { SourceNamespaceInventory } from "$lib/server/source/inventory";
import { BitbucketServerClient } from "./client";
import {
  BITBUCKET_BRANCHES_SCOPE,
  BITBUCKET_COMMITS_SCOPE,
  BITBUCKET_FORKS_SCOPE,
  BITBUCKET_PULL_REQUESTS_SCOPE,
  BITBUCKET_TAGS_SCOPE,
  collectBitbucketBranchMetric,
  collectBitbucketCommitMetric,
  collectBitbucketProfileEnrichment,
} from "./profile";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWithResponses(responses: Response[]) {
  const calls: URL[] = [];
  const client = new BitbucketServerClient({
    baseUrl: "https://bitbucket.example.com",
    username: "migration-user",
    password: "secret-password",
    maxRetries: 0,
    fetch: async (input) => {
      calls.push(new URL(input.toString()));
      const response = responses.shift();
      if (!response) throw new Error("unexpected fetch");
      return response;
    },
  });
  return { calls, client };
}

function page(values: unknown[], extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ values, isLastPage: true, ...extra });
}

function inventory(): SourceNamespaceInventory {
  const unavailable = { kind: "unavailable", reason: "not-reported" } as const;
  return {
    version: 1,
    provider: "bitbucket-server",
    sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
    namespace: "PC",
    projectCount: { kind: "exact", value: 1 },
    projects: [
      {
        provider: "bitbucket-server",
        sourceId: "7",
        path: "PC/service-api",
        name: "Service API",
        visibility: "private",
        archived: false,
        defaultBranch: "main",
        lastActivityAt: null,
        repositorySizeBytes: { kind: "exact", value: 128 },
        storageSizeBytes: { kind: "exact", value: 128 },
        lfsObjectsSizeBytes: unavailable,
        packagesSizeBytes: unavailable,
        wikiSizeBytes: unavailable,
        uploadsSizeBytes: unavailable,
        providerDetails: { provider: "bitbucket-server" },
      },
    ],
  };
}

describe("Bitbucket repository profile metrics", () => {
  test("uses withCounts for commits reachable from the default branch", async () => {
    const { calls, client } = clientWithResponses([page([{}], { totalCount: 42 })]);

    const metric = await collectBitbucketCommitMetric(
      client,
      { path: "PC/service-api", defaultBranch: "main" },
      { nowMs: Date.parse("2026-08-10T12:00:00Z") },
    );

    expect(metric).toEqual({
      provider: "bitbucket-server",
      endpointFamily: "repository-commits",
      collectedAt: "2026-08-10T12:00:00.000Z",
      observation: {
        kind: "exact",
        value: 42,
        basis: "reported",
        scope: BITBUCKET_COMMITS_SCOPE,
      },
    });
    expect(calls[0]?.pathname).toBe("/rest/api/1.0/projects/PC/repos/service-api/commits");
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toMatchObject({
      until: "main",
      withCounts: "true",
      limit: "1",
    });
  });

  test("does not invent a commit zero when the default branch is unknown", async () => {
    const { client, calls } = clientWithResponses([]);

    await expect(
      collectBitbucketCommitMetric(client, {
        path: "PC/empty",
        defaultBranch: null,
      }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "not-reported" },
    });
    expect(calls).toHaveLength(0);
  });

  test("preserves malformed and forbidden commit observations", async () => {
    const malformed = clientWithResponses([page([], { totalCount: "zero" })]).client;
    await expect(
      collectBitbucketCommitMetric(malformed, {
        path: "PC/service-api",
        defaultBranch: "main",
      }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "malformed" },
    });

    const forbidden = clientWithResponses([new Response(null, { status: 401 })]).client;
    await expect(
      collectBitbucketCommitMetric(forbidden, {
        path: "PC/service-api",
        defaultBranch: "main",
      }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "forbidden" },
    });
  });

  test("enumerates cursor pages and preserves branch permission denial", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse({ values: [{}, {}], isLastPage: false, nextPageStart: 7 }),
      page([{}]),
    ]);

    await expect(
      collectBitbucketBranchMetric(client, { path: "PC/service-api" }),
    ).resolves.toMatchObject({
      observation: { kind: "exact", value: 3, basis: "enumerated" },
    });
    expect(calls[1]?.searchParams.get("start")).toBe("7");

    const forbidden = clientWithResponses([new Response(null, { status: 403 })]).client;
    await expect(
      collectBitbucketBranchMetric(forbidden, { path: "PC/service-api" }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "forbidden" },
    });
  });

  test("collects all five metrics sequentially with explicit pull-request filters", async () => {
    const { client, calls } = clientWithResponses([
      page([{}], { totalCount: 3 }),
      page([{}]),
      page([{}, {}]),
      page([{}]),
      page([]),
    ]);

    const enrichment = await collectBitbucketProfileEnrichment(client, inventory(), {
      concurrency: 1,
      nowMs: Date.parse("2026-08-10T12:00:00Z"),
    });

    expect(enrichment).toMatchObject({
      version: 2,
      provider: "bitbucket-server",
      namespace: "PC",
      projects: [
        {
          sourceId: "7",
          path: "PC/service-api",
          metrics: {
            commits: {
              observation: { kind: "exact", value: 3, scope: BITBUCKET_COMMITS_SCOPE },
            },
            pullRequests: {
              observation: {
                kind: "exact",
                value: 1,
                scope: BITBUCKET_PULL_REQUESTS_SCOPE,
              },
            },
            branches: {
              observation: { kind: "exact", value: 2, scope: BITBUCKET_BRANCHES_SCOPE },
            },
            tags: {
              observation: { kind: "exact", value: 1, scope: BITBUCKET_TAGS_SCOPE },
            },
            forks: {
              observation: { kind: "exact", value: 0, scope: BITBUCKET_FORKS_SCOPE },
            },
          },
        },
      ],
    });
    expect(calls.map((call) => call.pathname)).toEqual([
      "/rest/api/1.0/projects/PC/repos/service-api/commits",
      "/rest/api/1.0/projects/PC/repos/service-api/pull-requests",
      "/rest/api/1.0/projects/PC/repos/service-api/branches",
      "/rest/api/1.0/projects/PC/repos/service-api/tags",
      "/rest/api/1.0/projects/PC/repos/service-api/forks",
    ]);
    expect(Object.fromEntries(calls[1]?.searchParams ?? [])).toMatchObject({
      direction: "INCOMING",
      state: "ALL",
    });
    expect(calls[2]?.searchParams.get("details")).toBe("false");
  });

  test("bounds repository workers while preserving inventory order", async () => {
    const sourceInventory = inventory();
    const firstProject = sourceInventory.projects[0];
    if (!firstProject) throw new Error("fixture project missing");
    sourceInventory.projectCount = { kind: "exact", value: 3 };
    sourceInventory.projects = [
      firstProject,
      { ...firstProject, sourceId: "8", path: "PC/web-client", name: "Web Client" },
      { ...firstProject, sourceId: "9", path: "PC/worker", name: "Worker" },
    ];
    let active = 0;
    let maximumActive = 0;
    const callsByRepository = new Map<string, string[]>();
    const client = new BitbucketServerClient({
      baseUrl: "https://bitbucket.example.com",
      username: "migration-user",
      password: "secret-password",
      maxRetries: 0,
      fetch: async (input) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        active -= 1;
        const url = new URL(input.toString());
        const match = url.pathname.match(/\/repos\/([^/]+)\/([^/]+)$/);
        if (!match) throw new Error(`unexpected path ${url.pathname}`);
        const [, repository, collection] = match;
        callsByRepository.set(repository ?? "", [
          ...(callsByRepository.get(repository ?? "") ?? []),
          collection ?? "",
        ]);
        return collection === "commits" ? page([{}], { totalCount: 1 }) : page([]);
      },
    });

    const enrichment = await collectBitbucketProfileEnrichment(client, sourceInventory, {
      concurrency: 2,
    });

    expect(maximumActive).toBe(2);
    expect(enrichment.projects.map((project) => project.path)).toEqual([
      "PC/service-api",
      "PC/web-client",
      "PC/worker",
    ]);
    for (const calls of callsByRepository.values()) {
      expect(calls).toEqual(["commits", "pull-requests", "branches", "tags", "forks"]);
    }
  });
});
