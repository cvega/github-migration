import { describe, expect, test } from "bun:test";
import { getSourceProviderAdapter } from "$lib/source-provider";
import { GitLabApiError, GitLabClient } from "./client";
import { discoverGitLabInventory, streamGitLabInventoryPages } from "./inventory";

function jsonResponse(data: unknown, nextPage = ""): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json", "X-Next-Page": nextPage },
  });
}

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name: "payments-api",
    path_with_namespace: "platform/products/services/payments-api",
    visibility: "private",
    archived: false,
    default_branch: "main",
    last_activity_at: "2026-08-01T12:00:00Z",
    web_url: "https://gitlab.example.com/platform/products/services/payments-api",
    description: "Payments API",
    topics: ["payments", "service"],
    empty_repo: false,
    forked_from_project: { path_with_namespace: "platform/templates/service" },
    issues_enabled: true,
    merge_requests_enabled: true,
    wiki_enabled: false,
    snippets_enabled: false,
    container_registry_enabled: true,
    statistics: {
      repository_size: 1_024,
      storage_size: 2_048,
      lfs_objects_size: 512,
      packages_size: 256,
      wiki_size: 128,
      uploads_size: 64,
    },
    ...overrides,
  };
}

function clientWithResponses(responses: Response[]) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(input.toString()), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  };
  return {
    calls,
    client: new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "secret-token",
      fetch,
      maxRetries: 0,
    }),
  };
}

describe("discoverGitLabInventory", () => {
  test("streams nested group projects into normalized inventory", async () => {
    const { calls, client } = clientWithResponses([
      jsonResponse([project()], "2"),
      jsonResponse([
        project({
          id: 43,
          name: "portal",
          path_with_namespace: "platform/products/customer/portal",
          visibility: "internal",
          archived: true,
          default_branch: null,
          statistics: undefined,
        }),
      ]),
      jsonResponse({ id: 43 }),
    ]);
    const progress: unknown[] = [];

    const inventory = await discoverGitLabInventory(client, "platform/products", {
      onProgress: (event) => progress.push(event),
    });

    expect(inventory.provider).toBe("gitlab");
    expect(inventory.version).toBe(1);
    expect(inventory.sourceApiUrl).toBe("https://gitlab.example.com/api/v4");
    expect(inventory.namespace).toBe("platform/products");
    expect(inventory.projectCount).toEqual({ kind: "at-least", value: 2 });
    expect(inventory.projects.map((item) => item.path)).toEqual([
      "platform/products/customer/portal",
      "platform/products/services/payments-api",
    ]);
    expect(inventory.projects[1]).toMatchObject({
      sourceId: "42",
      repositorySizeBytes: { kind: "exact", value: 1_024 },
      storageSizeBytes: { kind: "exact", value: 2_048 },
      providerDetails: {
        provider: "gitlab",
        webUrl: "https://gitlab.example.com/platform/products/services/payments-api",
        description: "Payments API",
        topics: ["payments", "service"],
        emptyRepository: false,
        forkedFromPath: "platform/templates/service",
        features: {
          issues: true,
          mergeRequests: true,
          wiki: false,
          snippets: false,
          containerRegistry: true,
        },
      },
    });
    expect(inventory.projects[0]).toMatchObject({
      sourceId: "43",
      archived: true,
      defaultBranch: null,
      repositorySizeBytes: { kind: "unavailable", reason: "not-reported" },
      packagesSizeBytes: { kind: "unavailable", reason: "not-reported" },
    });
    expect(progress).toEqual([
      { provider: "gitlab", namespace: "platform/products", discovered: 1, page: 1 },
      { provider: "gitlab", namespace: "platform/products", discovered: 2, page: 2 },
    ]);
    expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2", null]);
    expect(calls[0]?.url.pathname).toBe("/api/v4/groups/platform%2Fproducts/projects");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toMatchObject({
      include_subgroups: "true",
      order_by: "path",
      per_page: "100",
      simple: "false",
      sort: "asc",
      statistics: "true",
      with_shared: "false",
    });
  });

  test("enforces the adapter limit before emitting an oversized page", async () => {
    const adapter = getSourceProviderAdapter("gitlab");
    const previousLimit = adapter.inventoryProjectLimit;
    adapter.inventoryProjectLimit = 1;
    const { client } = clientWithResponses([
      jsonResponse([
        project(),
        project({
          id: 43,
          name: "worker",
          path_with_namespace: "platform/products/services/worker",
        }),
      ]),
    ]);
    const progress: unknown[] = [];

    try {
      await expect(
        discoverGitLabInventory(client, "platform/products", {
          onProgress: (event) => progress.push(event),
        }),
      ).rejects.toThrow(/1-project collection limit/);
      expect(progress).toHaveLength(0);
    } finally {
      adapter.inventoryProjectLimit = previousLimit;
    }
  });

  test("reports an exact count when stable pagination totals match", async () => {
    const response = jsonResponse([project()]);
    response.headers.set("X-Total", "1");
    const { client } = clientWithResponses([response]);

    expect((await discoverGitLabInventory(client, "platform/products")).projectCount).toEqual({
      kind: "exact",
      value: 1,
    });
  });

  test("reports a reconciled multi-page offset scan as a lower bound", async () => {
    const first = jsonResponse([project()], "2");
    first.headers.set("X-Total", "2");
    const second = jsonResponse([
      project({
        id: 43,
        name: "payments-worker",
        path_with_namespace: "platform/products/services/payments-worker",
      }),
    ]);
    second.headers.set("X-Total", "2");
    const { client } = clientWithResponses([first, second]);

    expect((await discoverGitLabInventory(client, "platform/products")).projectCount).toEqual({
      kind: "at-least",
      value: 2,
    });
  });

  test("rejects terminal pagination that contradicts the advertised page count", async () => {
    const response = jsonResponse([project()]);
    response.headers.set("X-Total-Pages", "2");
    const { client, calls } = clientWithResponses([response]);

    await expect(discoverGitLabInventory(client, "platform/products")).rejects.toThrow(
      "contradictory pagination",
    );
    expect(calls).toHaveLength(1);
  });

  test("keeps reported zero distinct from unavailable statistics", async () => {
    const { client } = clientWithResponses([
      jsonResponse([
        project({
          statistics: {
            repository_size: 0,
            storage_size: 0,
            lfs_objects_size: 0,
            packages_size: 0,
            wiki_size: 0,
            uploads_size: 0,
          },
        }),
        project({
          id: 43,
          path_with_namespace: "platform/products/services/payments-worker",
          statistics: null,
        }),
      ]),
      jsonResponse({ id: 43, statistics: null }),
    ]);

    const inventory = await discoverGitLabInventory(client, "platform/products");

    expect(inventory.projects[0]?.repositorySizeBytes).toEqual({ kind: "exact", value: 0 });
    expect(inventory.projects[1]?.repositorySizeBytes).toEqual({
      kind: "unavailable",
      reason: "not-reported",
    });
  });

  test("fills null listing statistics from the GitLab 19.6 project response", async () => {
    const { client, calls } = clientWithResponses([
      jsonResponse([project({ statistics: null })]),
      jsonResponse({
        id: 42,
        statistics: {
          commit_count: 17,
          storage_size: 2048,
          repository_size: 1024,
          wiki_size: 0,
          lfs_objects_size: 0,
          job_artifacts_size: 768,
          pipeline_artifacts_size: 128,
          packages_size: 0,
          snippets_size: 64,
          uploads_size: 64,
          container_registry_size: 0,
        },
      }),
    ]);

    const inventory = await discoverGitLabInventory(client, "platform/products");

    expect(calls[1]?.url.pathname).toBe("/api/v4/projects/42");
    expect(calls[1]?.url.searchParams.get("statistics")).toBe("true");
    expect(client.getApiCalls()).toBe(2);
    expect(inventory.projects[0]).toMatchObject({
      repositorySizeBytes: { kind: "exact", value: 1024 },
      jobArtifactsSizeBytes: { kind: "exact", value: 768 },
      pipelineArtifactsSizeBytes: { kind: "exact", value: 128 },
      snippetsSizeBytes: { kind: "exact", value: 64 },
      containerRegistrySizeBytes: { kind: "exact", value: 0 },
      providerDetails: { commitCount: { kind: "exact", value: 17 } },
    });
  });

  test.each([
    [403, "forbidden"],
    [404, "not-found-or-hidden"],
    [503, "transient-failure"],
  ])("retains the project when statistics return HTTP %i", async (status, reason) => {
    const { client } = clientWithResponses([
      jsonResponse([project({ statistics: null })]),
      new Response(null, { status }),
    ]);

    const inventory = await discoverGitLabInventory(client, "platform/products");

    expect(inventory.projects[0]).toMatchObject({
      repositorySizeBytes: { kind: "unavailable", reason },
      containerRegistrySizeBytes: { kind: "unavailable", reason },
      providerDetails: { commitCount: { kind: "unavailable", reason } },
    });
  });

  test("limits concurrent statistics requests and accounts for retries", async () => {
    const projects = Array.from({ length: 10 }, (_, index) =>
      project({
        id: index + 1,
        path_with_namespace: `platform/products/repo-${index}`,
        statistics: null,
      }),
    );
    const attempts = new Map<number, number>();
    let active = 0;
    let peak = 0;
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "fixture-token",
      maxRetries: 1,
      sleep: async () => {},
      fetch: async (input) => {
        const path = new URL(input.toString()).pathname;
        if (path.includes("/groups/")) return jsonResponse(projects);
        const id = Number(path.split("/").at(-1));
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(1);
        active -= 1;
        return id === 1 && attempt === 1
          ? new Response(null, { status: 503 })
          : jsonResponse({ id, statistics: { repository_size: id } });
      },
    });

    const inventory = await discoverGitLabInventory(client, "platform/products");

    expect(peak).toBe(4);
    expect(attempts.size).toBe(10);
    expect(client.getApiCalls()).toBe(12);
    expect(inventory.projects[0]?.repositorySizeBytes).toEqual({ kind: "exact", value: 1 });
  });

  test("streams normalized pages without collecting the namespace inventory", async () => {
    const { client } = clientWithResponses([
      jsonResponse([project()], "2"),
      jsonResponse([
        project({
          id: 43,
          name: "payments-worker",
          path_with_namespace: "platform/products/services/payments-worker",
        }),
      ]),
    ]);
    const pagePaths: string[][] = [];

    for await (const page of streamGitLabInventoryPages(client, "platform/products")) {
      pagePaths.push(page.map((item) => item.path));
    }

    expect(pagePaths).toEqual([
      ["platform/products/services/payments-api"],
      ["platform/products/services/payments-worker"],
    ]);
  });

  test("rejects malformed required fields and statistics", async () => {
    for (const malformed of [
      project({ path_with_namespace: "" }),
      project({ visibility: "restricted" }),
      project({ archived: "false" }),
      project({ statistics: { repository_size: -1 } }),
      project({ topics: ["valid", 42] }),
      project({ forked_from_project: "platform/template" }),
      project({ issues_enabled: "true" }),
    ]) {
      const { client } = clientWithResponses([jsonResponse([malformed])]);
      await expect(discoverGitLabInventory(client, "platform/services")).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });

  test("returns an exact zero for a fully enumerated empty group", async () => {
    const { client } = clientWithResponses([jsonResponse([])]);

    await expect(discoverGitLabInventory(client, "platform/empty")).resolves.toEqual({
      version: 1,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform/empty",
      projectCount: { kind: "exact", value: 0 },
      projects: [],
    });
  });

  test("rejects noncanonical namespaces and out-of-scope or duplicate projects", async () => {
    const whitespace = clientWithResponses([]).client;
    await expect(discoverGitLabInventory(whitespace, " platform/products ")).rejects.toThrow(
      "surrounding whitespace",
    );

    const outside = clientWithResponses([
      jsonResponse([project({ path_with_namespace: "another-group/payments-api" })]),
    ]).client;
    await expect(discoverGitLabInventory(outside, "platform/products")).rejects.toThrow(
      "outside namespace",
    );

    const duplicate = clientWithResponses([
      jsonResponse([project(), project({ name: "payments-copy" })]),
    ]).client;
    await expect(discoverGitLabInventory(duplicate, "platform/products")).rejects.toThrow(
      "duplicate project",
    );
  });

  test("aborts after page progress without dispatching another request", async () => {
    const { calls, client } = clientWithResponses([jsonResponse([project()], "2")]);
    const controller = new AbortController();

    const result = discoverGitLabInventory(client, "platform/products", {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await expect(result).rejects.toBeInstanceOf(GitLabApiError);
    expect(calls).toHaveLength(1);
  });

  test("represents an inaccessible namespace as unavailable", async () => {
    for (const [status, reason] of [
      [403, "forbidden"],
      [404, "not-found-or-hidden"],
    ] as const) {
      const { client } = clientWithResponses([
        new Response(null, { status, headers: { "content-type": "application/json" } }),
      ]);
      await expect(discoverGitLabInventory(client, "platform/products")).resolves.toMatchObject({
        projectCount: { kind: "unavailable", reason },
        projects: [],
      });
    }
  });

  test("fails the scan without returning a partial inventory when authorization is lost", async () => {
    for (const status of [401, 403]) {
      const { calls, client } = clientWithResponses([
        jsonResponse([project()], "2"),
        new Response(null, { status, headers: { "content-type": "application/json" } }),
      ]);

      await expect(discoverGitLabInventory(client, "platform/products")).rejects.toMatchObject({
        status,
      });
      expect(calls).toHaveLength(2);
    }
  });
});
