import { describe, expect, test } from "bun:test";
import { GitLabClient } from "./client";
import { collectGitLabContainerRegistryMetric } from "./metrics/container-registry.collector";

function fixture(responses: Response[]) {
  const calls: URL[] = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "offline-fixture",
    maxRetries: 0,
    fetch: async (input) => {
      calls.push(new URL(input.toString()));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected registry request");
      return response;
    },
  });
  return { client, calls };
}

const project = { sourceId: "platform/service" };
const json = (data: unknown, headers: Record<string, string> = {}) =>
  Response.json(data, { headers });

describe("GitLab container registry inventory", () => {
  test.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not-reported"],
  ] as const)("records HTTP %i independently of zero counts", async (status, reason) => {
    const { client } = fixture([new Response(null, { status })]);
    expect(await collectGitLabContainerRegistryMetric(client, project)).toMatchObject({
      observation: { kind: "unavailable", reason },
      tags: { kind: "unavailable", reason },
    });
  });

  test("keeps a tier-unavailable endpoint unknown without retaining its body", async () => {
    const { client } = fixture([
      new Response("Registry feature unavailable for this subscription", { status: 404 }),
    ]);
    const result = await collectGitLabContainerRegistryMetric(client, project);
    expect(result.observation).toMatchObject({ kind: "unavailable", reason: "not-reported" });
    expect(result.tags).toMatchObject({ kind: "unavailable", reason: "not-reported" });
    expect(JSON.stringify(result)).not.toContain("subscription");
  });

  test("enumerates repositories and sums reported tags without storing registry identities", async () => {
    const { client, calls } = fixture([
      json([{ id: 1, tags_count: 2, location: "discard-registry", path: "discard-path" }], {
        "X-Next-Page": "2",
      }),
      json([{ id: 2, tags_count: 3, url: "discard-url", name: "discard-name" }]),
    ]);
    const result = await collectGitLabContainerRegistryMetric(client, project, {
      nowMs: Date.parse("2026-11-28T10:00:00Z"),
    });
    expect(result).toMatchObject({
      provider: "gitlab",
      endpointFamily: "project-container-registry",
      collectedAt: "2026-11-28T10:00:00.000Z",
      observation: { kind: "exact", value: 2, basis: "enumerated" },
      tags: { kind: "exact", value: 5, basis: "reported" },
    });
    expect(JSON.stringify(result)).not.toContain("discard-");
    expect(
      calls.map(({ pathname, searchParams }) => [
        pathname,
        searchParams.get("page"),
        searchParams.get("tags_count"),
      ]),
    ).toEqual([
      ["/api/v4/projects/platform%2Fservice/registry/repositories", "1", "true"],
      ["/api/v4/projects/platform%2Fservice/registry/repositories", "2", "true"],
    ]);
  });

  test("an enabled but empty registry has exact zero repositories and tags", async () => {
    const { client } = fixture([json([])]);
    expect(await collectGitLabContainerRegistryMetric(client, project)).toMatchObject({
      observation: { kind: "exact", value: 0 },
      tags: { kind: "exact", value: 0 },
    });
  });

  test.each([undefined, null])(
    "missing tags_count (%p) does not hide the repository count",
    async (tags_count) => {
      const { client, calls } = fixture([json([{ id: 1, tags_count }])]);
      expect(await collectGitLabContainerRegistryMetric(client, project)).toMatchObject({
        observation: { kind: "exact", value: 1 },
        tags: { kind: "unavailable", reason: "not-reported" },
      });
      expect(calls).toHaveLength(1);
    },
  );

  test("retains known tags as a lower bound when another repository omits tags_count", async () => {
    const { client } = fixture([json([{ id: 1, tags_count: 2 }, { id: 2 }])]);
    expect(await collectGitLabContainerRegistryMetric(client, project)).toMatchObject({
      observation: { kind: "exact", value: 2 },
      tags: { kind: "at-least", value: 2, reason: "pagination-uncertain" },
    });
  });

  test("spends only the shared remaining budget, preserving both lower bounds", async () => {
    const { client, calls } = fixture([
      json([]),
      json([{ id: 1, tags_count: 4 }], { "X-Next-Page": "2" }),
    ]);
    await client.get("/projects/1");
    const result = await collectGitLabContainerRegistryMetric(client, project, {
      apiCallCeiling: 2,
    });
    expect(result.observation).toMatchObject({
      kind: "at-least",
      value: 1,
      reason: "request-budget",
    });
    expect(result.tags).toMatchObject({ kind: "at-least", value: 4, reason: "request-budget" });
    expect(calls).toHaveLength(2);
    const exhausted = await collectGitLabContainerRegistryMetric(client, project, {
      apiCallCeiling: 2,
    });
    expect(exhausted.observation).toMatchObject({ kind: "unavailable", reason: "request-budget" });
    expect(exhausted.tags).toMatchObject({ kind: "unavailable", reason: "request-budget" });
    expect(calls).toHaveLength(2);
  });

  test("later access denial preserves observed repositories and tags", async () => {
    const { client } = fixture([
      json([{ id: 1, tags_count: 0 }], { "X-Next-Page": "2" }),
      new Response(null, { status: 403 }),
    ]);
    const result = await collectGitLabContainerRegistryMetric(client, project);
    expect(result.observation).toMatchObject({
      kind: "at-least",
      value: 1,
      reason: "pagination-uncertain",
    });
    expect(result.tags).toMatchObject({
      kind: "at-least",
      value: 0,
      reason: "pagination-uncertain",
    });
  });

  test.each([-1, "2", 1.5])(
    "invalid tag counts (%p) leave repository counts usable",
    async (tags_count) => {
      const { client } = fixture([json([{ id: 1, tags_count }])]);
      const result = await collectGitLabContainerRegistryMetric(client, project);
      expect(result.observation).toMatchObject({ kind: "exact", value: 1 });
      expect(result.tags).toMatchObject({ kind: "unavailable", reason: "malformed" });
    },
  );

  test.each([[{ id: 1 }, { id: 1 }], [{}]])(
    "rejects malformed or repeated repository identities (%j)",
    async (...entries) => {
      const { client } = fixture([json(entries)]);
      const result = await collectGitLabContainerRegistryMetric(client, project);
      expect(result.observation).toMatchObject({ kind: "unavailable", reason: "malformed" });
      expect(result.tags).toMatchObject({ kind: "unavailable", reason: "malformed" });
    },
  );

  test("propagates unexpected server failures and cancellation", async () => {
    const { client } = fixture([new Response(null, { status: 503 })]);
    await expect(collectGitLabContainerRegistryMetric(client, project)).rejects.toMatchObject({
      status: 503,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectGitLabContainerRegistryMetric(client, project, { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
