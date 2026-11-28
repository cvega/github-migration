import { describe, expect, test } from "bun:test";
import type { SourceNamespaceInventory } from "$lib/source/types";
import { GitLabApiError, GitLabClient } from "./client";
import { collectGitLabPackageVersionMetric } from "./metrics/package-versions.collector";
import { collectGitLabProfileEnrichment } from "./profile";

const unavailable = { kind: "unavailable", reason: "not-reported" } as const;
const inventory: SourceNamespaceInventory = {
  version: 1,
  provider: "gitlab",
  sourceApiUrl: "https://gitlab.example.com/api/v4",
  namespace: "platform/services",
  projectCount: { kind: "exact", value: 2 },
  projects: ["1", "2"].map((sourceId) => ({
    provider: "gitlab",
    sourceId,
    path: `platform/services/project-${sourceId}`,
    name: `project-${sourceId}`,
    visibility: "private",
    archived: false,
    defaultBranch: "main",
    lastActivityAt: null,
    repositorySizeBytes: unavailable,
    storageSizeBytes: unavailable,
    lfsObjectsSizeBytes: unavailable,
    packagesSizeBytes: unavailable,
    wikiSizeBytes: unavailable,
    uploadsSizeBytes: unavailable,
    jobArtifactsSizeBytes: unavailable,
    pipelineArtifactsSizeBytes: unavailable,
    snippetsSizeBytes: unavailable,
    containerRegistrySizeBytes: unavailable,
    providerDetails: { provider: "gitlab" },
  })),
};

describe("GitLab package version collection", () => {
  async function restrictedProfile(restriction: Response) {
    const calls: string[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "offline-fixture",
      maxRetries: 0,
      fetch: async (input) => {
        const { pathname } = new URL(input.toString());
        calls.push(pathname);
        if (pathname === "/api/v4/projects/1/packages") return restriction;
        if (pathname.endsWith("/sequence")) return Response.json({ count: 4 });
        if (pathname.endsWith("/repository/branches/main")) {
          return Response.json({ commit: { id: "abc123" } });
        }
        return Response.json([]);
      },
    });
    const { projects } = await collectGitLabProfileEnrichment(client, inventory);
    expect(projects[1]?.metrics.packageVersions).toMatchObject({
      observation: { kind: "exact", value: 0 },
      ecosystemCounts: {},
    });
    expect(calls.filter((path) => path.endsWith("/packages")).sort()).toEqual([
      "/api/v4/projects/1/packages",
      "/api/v4/projects/2/packages",
    ]);
    expect(calls.some((path) => /^\/api\/v4\/groups\/.+\/packages$/.test(path))).toBe(false);
    return projects[0]?.metrics.packageVersions;
  }

  test.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not-reported"],
  ] as const)("continues after package HTTP %i with %s", async (status, reason) => {
    expect(await restrictedProfile(new Response(null, { status }))).toMatchObject({
      observation: { kind: "unavailable", reason },
      ecosystemCounts: null,
    });
  });

  test("keeps a tier-unavailable endpoint distinct from an empty registry", async () => {
    const result = await restrictedProfile(
      Response.json({ message: "Package registry unavailable on this tier" }, { status: 404 }),
    );
    expect(result).toMatchObject({
      observation: { kind: "unavailable", reason: "not-reported" },
      ecosystemCounts: null,
    });
    expect(JSON.stringify(result)).not.toContain("this tier");
  });

  function pagedClient(responses: Response[]) {
    const calls: URL[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "offline-fixture",
      maxRetries: 0,
      fetch: async (input) => {
        calls.push(new URL(input.toString()));
        const response = responses.shift();
        if (!response) throw new Error("unexpected fetch");
        return response;
      },
    });
    return { client, calls };
  }

  const firstPage = () =>
    Response.json([{ id: 1, package_type: "npm" }], { headers: { "X-Next-Page": "2" } });

  test("counts package entries by ecosystem across pages, retaining only safe aggregates", async () => {
    const { client, calls } = pagedClient([
      firstPage(),
      Response.json([
        { id: 2, package_type: "npm", name: "discard-name", version: "discard-version" },
        { id: 3, package_type: "maven", _links: { web_path: "discard-url" } },
        { id: 4, package_type: "discard-unknown-type", pipelines: [{ user: "discard-user" }] },
        { id: 5, package_type: "golang" },
      ]),
    ]);
    const result = await collectGitLabPackageVersionMetric(
      client,
      { sourceId: "platform/services/project" },
      { namespace: "platform/services", nowMs: Date.parse("2026-08-10T12:00:00Z") },
    );
    expect(result).toEqual({
      provider: "gitlab",
      endpointFamily: "project-packages",
      collectedAt: "2026-08-10T12:00:00.000Z",
      observation: {
        kind: "exact",
        value: 5,
        basis: "enumerated",
        scope: expect.stringContaining("status=default"),
      },
      ecosystemCounts: { npm: 2, maven: 1, other: 1, golang: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("discard-");
    expect(
      calls.map(({ pathname, searchParams }) => [pathname, Object.fromEntries(searchParams)]),
    ).toEqual([
      [
        "/api/v4/projects/platform%2Fservices%2Fproject/packages",
        { status: "default", page: "1", per_page: "100" },
      ],
      [
        "/api/v4/projects/platform%2Fservices%2Fproject/packages",
        { status: "default", page: "2", per_page: "100" },
      ],
    ]);
  });

  test.each([401, 403, 404])(
    "retains partial ecosystem evidence after page-two HTTP %i",
    async (status) => {
      const { client } = pagedClient([firstPage(), new Response(null, { status })]);
      expect(await collectGitLabPackageVersionMetric(client, { sourceId: "1" })).toMatchObject({
        observation: { kind: "at-least", value: 1, reason: "pagination-uncertain" },
        ecosystemCounts: { npm: 1 },
      });
    },
  );

  test("shares the existing client ceiling and preserves paginated lower bounds", async () => {
    const { client, calls } = pagedClient([Response.json({}), firstPage()]);
    await client.get("/projects/1");
    const partial = await collectGitLabPackageVersionMetric(
      client,
      { sourceId: "1" },
      { apiCallCeiling: 2 },
    );
    const unavailable = await collectGitLabPackageVersionMetric(
      client,
      { sourceId: "2" },
      { apiCallCeiling: 2 },
    );
    expect(partial).toMatchObject({
      observation: { kind: "at-least", value: 1, reason: "request-budget" },
      ecosystemCounts: { npm: 1 },
    });
    expect(unavailable).toMatchObject({
      observation: { kind: "unavailable", reason: "request-budget" },
      ecosystemCounts: null,
    });
    expect(calls).toHaveLength(2);
    expect(client.getApiCalls()).toBe(2);
  });

  test.each([
    {
      data: [
        { id: 2, package_type: "npm" },
        { id: 2, package_type: "npm" },
      ],
    },
    { data: [{ id: 1, package_type: "npm" }] },
    { data: [{ id: 2, package_type: "" }] },
    { data: [{ id: 2 }] },
    { data: { message: "discard-malformed-response" } },
  ])(
    "rejects malformed or duplicate evidence instead of retaining a plausible count (%j)",
    async ({ data }) => {
      const { client } = pagedClient([firstPage(), Response.json(data)]);
      expect(await collectGitLabPackageVersionMetric(client, { sourceId: "1" })).toMatchObject({
        observation: { kind: "unavailable", reason: "malformed" },
        ecosystemCounts: null,
      });
    },
  );

  test("rejects contradictory pagination rather than exposing partial ecosystem counts", async () => {
    const { client } = pagedClient([
      firstPage(),
      Response.json([{ id: 2, package_type: "npm" }], { headers: { "X-Total": "1" } }),
    ]);
    expect(await collectGitLabPackageVersionMetric(client, { sourceId: "1" })).toMatchObject({
      observation: { kind: "unavailable", reason: "malformed" },
      ecosystemCounts: null,
    });
  });

  test("propagates unexpected server failures and cancellation", async () => {
    const { client } = pagedClient([new Response(null, { status: 500 })]);
    await expect(
      collectGitLabPackageVersionMetric(client, { sourceId: "1" }),
    ).rejects.toBeInstanceOf(GitLabApiError);
    const aborted = pagedClient([]);
    await expect(
      collectGitLabPackageVersionMetric(
        aborted.client,
        { sourceId: "1" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toBeInstanceOf(GitLabApiError);
    expect(aborted.calls).toHaveLength(0);
  });
});
