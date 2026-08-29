import { describe, expect, test } from "bun:test";
import { BitbucketServerClient } from "./client";
import {
  assertSupportedBitbucketServerVersion,
  discoverBitbucketInventory,
  streamBitbucketInventoryPages,
} from "./inventory";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(responses: Response[]): BitbucketServerClient {
  return new BitbucketServerClient({
    baseUrl: "https://bitbucket.example.com",
    username: "user",
    password: "secret",
    maxRetries: 0,
    fetch: async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    },
  });
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    slug: "widget",
    name: "Widget",
    public: false,
    archived: false,
    defaultBranch: { displayId: "main" },
    updatedDate: 1_786_147_200_000,
    size: 4_096,
    description: "Widget repository",
    scmId: "git",
    forkable: true,
    origin: { slug: "template", project: { key: "PLATFORM" } },
    links: {
      self: [{ href: "https://bitbucket.example.com/projects/PLATFORM/repos/widget/browse" }],
    },
    ...overrides,
  };
}

describe("Bitbucket Server inventory", () => {
  test("normalizes paginated repositories and reports progress", async () => {
    const api = client([
      response({ version: "8.19.2" }),
      response({ values: [repository()], isLastPage: false, nextPageStart: 5 }),
      response({
        values: [
          repository({
            id: 8,
            slug: "public-repo",
            name: "Public Repo",
            public: true,
            archived: undefined,
            state: "ARCHIVED",
            defaultBranch: null,
            updatedDate: null,
            size: undefined,
          }),
        ],
        isLastPage: true,
      }),
    ]);
    const progress: number[] = [];

    const inventory = await discoverBitbucketInventory(api, "PLATFORM", {
      onProgress: ({ discovered }) => progress.push(discovered),
    });

    expect(inventory.projectCount).toEqual({ kind: "exact", value: 2 });
    expect(inventory.projects[0]).toMatchObject({
      provider: "bitbucket-server",
      sourceId: "8",
      path: "PLATFORM/public-repo",
      visibility: "public",
      archived: true,
      defaultBranch: null,
      repositorySizeBytes: { kind: "unavailable", reason: "not-reported" },
    });
    expect(inventory.projects[1]).toMatchObject({
      sourceId: "7",
      path: "PLATFORM/widget",
      visibility: "private",
      defaultBranch: "main",
      repositorySizeBytes: { kind: "exact", value: 4096 },
      providerDetails: {
        provider: "bitbucket-server",
        webUrl: "https://bitbucket.example.com/projects/PLATFORM/repos/widget/browse",
        description: "Widget repository",
        scmId: "git",
        forkable: true,
        forkedFromPath: "PLATFORM/template",
      },
    });
    expect(progress).toEqual([1, 2]);
    expect(api.getApiCalls()).toBe(3);
  });

  test("rejects unsupported and malformed server versions", async () => {
    await expect(
      assertSupportedBitbucketServerVersion(client([response({ version: "5.13.9" })])),
    ).rejects.toThrow("below the minimum");
    await expect(
      assertSupportedBitbucketServerVersion(client([response({ version: "unknown" })])),
    ).rejects.toThrow("invalid");
    await expect(assertSupportedBitbucketServerVersion(client([response({})]))).rejects.toThrow(
      "not reported",
    );
  });

  test("rejects duplicate numeric identities and case-insensitive paths", async () => {
    const duplicateId = client([
      response({
        values: [repository(), repository({ slug: "other", id: 7 })],
        isLastPage: true,
      }),
    ]);
    await expect(
      (async () => {
        for await (const _page of streamBitbucketInventoryPages(duplicateId, "PLATFORM")) {
          // consume
        }
      })(),
    ).rejects.toThrow("duplicate repository");

    const duplicatePath = client([
      response({
        values: [repository(), repository({ id: 8, slug: "WIDGET" })],
        isLastPage: true,
      }),
    ]);
    await expect(
      (async () => {
        for await (const _page of streamBitbucketInventoryPages(duplicatePath, "PLATFORM")) {
          // consume
        }
      })(),
    ).rejects.toThrow("duplicate repository");
  });

  test("represents forbidden and hidden projects as unavailable", async () => {
    for (const [status, reason] of [
      [403, "forbidden"],
      [404, "not-found-or-hidden"],
    ] as const) {
      const inventory = await discoverBitbucketInventory(
        client([response({ version: "9.0.0" }), response({}, status)]),
        "PLATFORM",
      );
      expect(inventory.projectCount).toEqual({ kind: "unavailable", reason });
      expect(inventory.projects).toEqual([]);
    }
  });

  test("rejects malformed repository fields and invalid project keys", async () => {
    expect(() => discoverBitbucketInventory(client([]), " PLATFORM ")).toThrow(
      "project key is invalid",
    );
    const api = client([
      response({ version: "8.0.0" }),
      response({ values: [repository({ id: 0 })], isLastPage: true }),
    ]);
    await expect(discoverBitbucketInventory(api, "PLATFORM")).rejects.toThrow("positive integer");

    for (const malformed of [
      repository({ links: { self: "not-an-array" } }),
      repository({ origin: { slug: "template" } }),
      repository({ forkable: "true" }),
    ]) {
      const malformedApi = client([
        response({ version: "8.0.0" }),
        response({ values: [malformed], isLastPage: true }),
      ]);
      await expect(discoverBitbucketInventory(malformedApi, "PLATFORM")).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });
});
