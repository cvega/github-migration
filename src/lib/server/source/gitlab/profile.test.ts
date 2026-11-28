import { describe, expect, spyOn, test } from "bun:test";
import { GitLabClient } from "./client";
import {
  collectGitLabBranchMetric,
  collectGitLabCommitMetric,
  collectGitLabIssueMetric,
  collectGitLabMergeRequestMetric,
  collectGitLabProfileEnrichment,
  collectGitLabReleaseMetric,
  collectGitLabTagMetric,
  GITLAB_BRANCHES_SCOPE,
  GITLAB_COMMITS_SCOPE,
  GITLAB_ISSUES_SCOPE,
  GITLAB_MERGE_REQUESTS_SCOPE,
  GITLAB_RELEASES_SCOPE,
  GITLAB_TAGS_SCOPE,
} from "./profile";

function clientWithResponses(responses: Response[]) {
  const calls: URL[] = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "secret-token",
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

function jsonResponse(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("collectGitLabIssueMetric", () => {
  test("records an exact provider-reported count with its scope and provenance", async () => {
    const { calls, client } = clientWithResponses([jsonResponse([{}], { "X-Total": "42" })]);

    const metric = await collectGitLabIssueMetric(
      client,
      { sourceId: "platform/payments" },
      { nowMs: Date.parse("2026-08-10T12:00:00Z") },
    );

    expect(metric).toEqual({
      provider: "gitlab",
      endpointFamily: "project-issues",
      collectedAt: "2026-08-10T12:00:00.000Z",
      observation: {
        kind: "exact",
        value: 42,
        basis: "reported",
        scope: GITLAB_ISSUES_SCOPE,
      },
    });
    expect(calls[0]?.pathname).toBe("/api/v4/projects/platform%2Fpayments/issues");
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toMatchObject({
      page: "1",
      per_page: "1",
      scope: "all",
      state: "all",
    });
  });

  test("keeps a missing total as a request-bounded lower bound", async () => {
    const { client } = clientWithResponses([jsonResponse([{}])]);

    await expect(collectGitLabIssueMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: {
        kind: "at-least",
        value: 1,
        reason: "request-budget",
        scope: GITLAB_ISSUES_SCOPE,
      },
    });
  });

  test.each<{ data: unknown[]; headers: Record<string, string> }>([
    { data: [], headers: { "X-Total": "0", "X-Next-Page": "2" } },
    { data: [{}], headers: { "X-Total": "1", "X-Total-Pages": "2" } },
    { data: [], headers: { "X-Total-Pages": "2" } },
  ])(
    "keeps contradictory pagination unavailable with scoped provenance (%j)",
    async ({ data, headers }) => {
      const { client } = clientWithResponses([jsonResponse(data, headers)]);

      await expect(collectGitLabIssueMetric(client, { sourceId: "42" })).resolves.toMatchObject({
        provider: "gitlab",
        endpointFamily: "project-issues",
        observation: {
          kind: "unavailable",
          reason: "malformed",
          scope: GITLAB_ISSUES_SCOPE,
        },
      });
    },
  );

  test("preserves permission denial instead of reporting zero", async () => {
    const { client } = clientWithResponses([new Response(null, { status: 403 })]);

    await expect(collectGitLabIssueMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: {
        kind: "unavailable",
        reason: "forbidden",
        scope: GITLAB_ISSUES_SCOPE,
      },
    });
  });
});

describe("GitLab repository metric collectors", () => {
  test("records merge requests from the explicit all-state, all-author scope", async () => {
    const { calls, client } = clientWithResponses([jsonResponse([{}], { "X-Total": "7" })]);

    const metric = await collectGitLabMergeRequestMetric(client, { sourceId: "42" });

    expect(metric.observation).toEqual({
      kind: "exact",
      value: 7,
      basis: "reported",
      scope: GITLAB_MERGE_REQUESTS_SCOPE,
    });
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toMatchObject({
      scope: "all",
      state: "all",
    });
  });

  test("enumerates branches, tags, and releases to their terminal pages", async () => {
    const { client } = clientWithResponses([
      jsonResponse([{}, {}], { "X-Next-Page": "2", "X-Total": "3" }),
      jsonResponse([{}], { "X-Next-Page": "", "X-Total": "3" }),
      jsonResponse([{}]),
      jsonResponse([]),
    ]);

    await expect(collectGitLabBranchMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "exact", value: 3, basis: "enumerated", scope: GITLAB_BRANCHES_SCOPE },
    });
    await expect(collectGitLabTagMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "exact", value: 1, basis: "enumerated", scope: GITLAB_TAGS_SCOPE },
    });
    await expect(collectGitLabReleaseMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "exact", value: 0, basis: "enumerated", scope: GITLAB_RELEASES_SCOPE },
    });
  });

  test("keeps a release count unavailable when a terminal header disagrees with Link", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse([{}], { "X-Next-Page": "2" }),
      jsonResponse([{}], { "X-Next-Page": "", Link: '<?page=3>; rel="next"' }),
    ]);

    await expect(collectGitLabReleaseMetric(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "malformed", scope: GITLAB_RELEASES_SCOPE },
    });
    expect(calls.map((call) => call.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  test.each([
    [collectGitLabBranchMetric, "repository-branches", GITLAB_BRANCHES_SCOPE],
    [collectGitLabTagMetric, "repository-tags", GITLAB_TAGS_SCOPE],
    [collectGitLabReleaseMetric, "project-releases", GITLAB_RELEASES_SCOPE],
  ] as const)("explains rejected enumeration for %s", async (collect, endpointFamily, scope) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client } = clientWithResponses([
        jsonResponse([{}], { "X-Total": "private-provider-payload" }),
      ]);

      await expect(collect(client, { sourceId: "private-project" })).resolves.toMatchObject({
        endpointFamily,
        observation: { kind: "unavailable", reason: "malformed", scope },
      });
      expect(warn.mock.calls).toEqual([
        [
          `[gitlab] ${endpointFamily} count unavailable: GitLab API returned an invalid X-Total header`,
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    [collectGitLabTagMetric, GITLAB_TAGS_SCOPE],
    [collectGitLabReleaseMetric, GITLAB_RELEASES_SCOPE],
  ] as const)("enumerates without X-Total for %s", async (collect, scope) => {
    const { client, calls } = clientWithResponses([
      jsonResponse([{}], { "X-Next-Page": "2" }),
      jsonResponse([{}, {}], { "X-Next-Page": "" }),
    ]);

    await expect(collect(client, { sourceId: "42" })).resolves.toMatchObject({
      observation: { kind: "exact", value: 3, basis: "enumerated", scope },
    });
    expect(calls.map((call) => call.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(client.getApiCalls()).toBe(2);
  });

  test("counts commits reachable from the reported default-branch head SHA", async () => {
    const { calls, client } = clientWithResponses([
      jsonResponse({ commit: { id: "abc123" } }),
      jsonResponse({ count: 12 }),
    ]);

    const metric = await collectGitLabCommitMetric(client, {
      sourceId: "42",
      defaultBranch: "main",
    });

    expect(metric.observation).toEqual({
      kind: "exact",
      value: 12,
      basis: "reported",
      scope: GITLAB_COMMITS_SCOPE,
    });
    expect(calls.map((call) => call.pathname)).toEqual([
      "/api/v4/projects/42/repository/branches/main",
      "/api/v4/projects/42/repository/commits/abc123/sequence",
    ]);
  });

  test("distinguishes an authoritative empty repository from an unknown default branch", async () => {
    const { client } = clientWithResponses([]);

    await expect(
      collectGitLabCommitMetric(client, {
        sourceId: "42",
        defaultBranch: null,
        providerDetails: { provider: "gitlab", emptyRepository: true },
      }),
    ).resolves.toMatchObject({
      observation: { kind: "exact", value: 0, basis: "enumerated" },
    });
    await expect(
      collectGitLabCommitMetric(client, { sourceId: "43", defaultBranch: null }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "not-reported" },
    });
  });

  test("preserves malformed and forbidden commit observations instead of reporting zero", async () => {
    const malformed = clientWithResponses([jsonResponse({ commit: {} })]).client;
    await expect(
      collectGitLabCommitMetric(malformed, { sourceId: "42", defaultBranch: "main" }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "malformed" },
    });

    const forbidden = clientWithResponses([new Response(null, { status: 403 })]).client;
    await expect(
      collectGitLabCommitMetric(forbidden, { sourceId: "42", defaultBranch: "main" }),
    ).resolves.toMatchObject({
      observation: { kind: "unavailable", reason: "forbidden" },
    });
  });
});

describe("collectGitLabProfileEnrichment", () => {
  test("collects all repository metrics for every inventory project in stable order", async () => {
    const { client } = clientWithResponses([
      jsonResponse([], { "X-Total": "0" }),
      jsonResponse([], { "X-Total": "0" }),
      jsonResponse([]),
      jsonResponse([]),
      jsonResponse([]),
      jsonResponse([{}], { "X-Total": "3" }),
      jsonResponse([{}], { "X-Total": "1" }),
      jsonResponse([{}, {}]),
      jsonResponse([{}]),
      jsonResponse([{}]),
    ]);

    const enrichment = await collectGitLabProfileEnrichment(
      client,
      {
        version: 1,
        provider: "gitlab",
        sourceApiUrl: "https://gitlab.example.com/api/v4",
        namespace: "platform",
        projectCount: { kind: "exact", value: 2 },
        projects: [
          {
            provider: "gitlab",
            sourceId: "1",
            path: "platform/api",
            name: "api",
            visibility: "private",
            archived: false,
            defaultBranch: null,
            lastActivityAt: null,
            repositorySizeBytes: { kind: "exact", value: 0 },
            storageSizeBytes: { kind: "exact", value: 0 },
            lfsObjectsSizeBytes: { kind: "exact", value: 0 },
            packagesSizeBytes: { kind: "exact", value: 0 },
            wikiSizeBytes: { kind: "exact", value: 0 },
            uploadsSizeBytes: { kind: "exact", value: 0 },
            jobArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            pipelineArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            snippetsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            containerRegistrySizeBytes: { kind: "unavailable", reason: "not-reported" },
            providerDetails: { provider: "gitlab", emptyRepository: true },
          },
          {
            provider: "gitlab",
            sourceId: "2",
            path: "platform/web",
            name: "web",
            visibility: "private",
            archived: false,
            defaultBranch: null,
            lastActivityAt: null,
            repositorySizeBytes: { kind: "exact", value: 0 },
            storageSizeBytes: { kind: "exact", value: 0 },
            lfsObjectsSizeBytes: { kind: "exact", value: 0 },
            packagesSizeBytes: { kind: "exact", value: 0 },
            wikiSizeBytes: { kind: "exact", value: 0 },
            uploadsSizeBytes: { kind: "exact", value: 0 },
            jobArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            pipelineArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            snippetsSizeBytes: { kind: "unavailable", reason: "not-reported" },
            containerRegistrySizeBytes: { kind: "unavailable", reason: "not-reported" },
            providerDetails: { provider: "gitlab", emptyRepository: true },
          },
        ],
      },
      { concurrency: 1, nowMs: Date.parse("2026-08-10T12:00:00Z") },
    );

    expect(enrichment).toMatchObject({
      version: 2,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform",
    });
    expect(enrichment.projects.map((project) => project.path)).toEqual([
      "platform/api",
      "platform/web",
    ]);
    expect(enrichment.projects.map((project) => project.metrics.issues.observation)).toEqual([
      {
        kind: "exact",
        value: 0,
        basis: "reported",
        scope: GITLAB_ISSUES_SCOPE,
      },
      {
        kind: "exact",
        value: 3,
        basis: "reported",
        scope: GITLAB_ISSUES_SCOPE,
      },
    ]);
    expect(enrichment.projects[1]?.metrics).toMatchObject({
      mergeRequests: { observation: { kind: "exact", value: 1, basis: "reported" } },
      commits: { observation: { kind: "exact", value: 0, basis: "enumerated" } },
      branches: { observation: { kind: "exact", value: 2, basis: "enumerated" } },
      tags: { observation: { kind: "exact", value: 1, basis: "enumerated" } },
      releases: { observation: { kind: "exact", value: 1, basis: "enumerated" } },
    });
  });
});
