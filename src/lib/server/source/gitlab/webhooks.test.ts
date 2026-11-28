import { describe, expect, test } from "bun:test";
import type { SourceNamespaceInventory } from "$lib/source/types";
import { GitLabClient } from "./client";
import { collectGitLabProfileEnrichment } from "./profile";
import {
  collectGitLabGroupWebhookMetric,
  collectGitLabProjectWebhookMetric,
  GitLabGroupHookCache,
} from "./webhooks";

const project = { sourceId: "42", path: "platform/services/nested/api" };
const options = { namespace: "platform/services", nowMs: Date.parse("2026-11-28T08:00:00Z") };
const json = (data: unknown, headers: Record<string, string> = {}) =>
  Response.json(data, { headers });

function fixture(responses: Response[], maxRetries = 0) {
  const calls: URL[] = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.invalid",
    token: "offline-fixture",
    maxRetries,
    sleep: async () => {},
    fetch: async (input) => {
      calls.push(new URL(input.toString()));
      const response = responses.shift();
      if (!response) throw new Error("unexpected fixture request");
      return response;
    },
  });
  return { client, calls };
}

describe("GitLab webhook dependencies", () => {
  test("paginates local hooks and keeps only counts and allowlisted enabled event categories", async () => {
    const { client, calls } = fixture([
      json(
        [
          {
            id: 1,
            push_events: true,
            pipeline_events: false,
            url: "discard-destination",
            custom_headers: [{ value: "discard-header" }],
            arbitrary_events: true,
          },
        ],
        { "X-Next-Page": "2" },
      ),
      json([{ id: 2, pipeline_events: true, push_events: true, token: "discard-value" }], {
        "X-Next-Page": "",
      }),
    ]);
    const metric = await collectGitLabProjectWebhookMetric(
      client,
      { ...project, sourceId: "platform/api" },
      options,
    );
    expect(metric).toMatchObject({
      provider: "gitlab",
      endpointFamily: "project-hooks",
      collectedAt: "2026-11-28T08:00:00.000Z",
      observation: { kind: "exact", value: 2, basis: "enumerated" },
      eventCategories: ["push", "pipeline"],
    });
    expect(calls.map((url) => [url.pathname, url.searchParams.get("page")])).toEqual([
      ["/api/v4/projects/platform%2Fapi/hooks", "1"],
      ["/api/v4/projects/platform%2Fapi/hooks", "2"],
    ]);
    expect(JSON.stringify(metric)).not.toMatch(/discard-|custom_headers|arbitrary_events|token/);
  });

  test("records inherited group impact even when the project has no local hooks, without leaving namespace scope", async () => {
    const { client, calls } = fixture([
      json([]),
      json([{ id: 3, deployment_events: true }]),
      json([{ id: 4, push_events: true }]),
    ]);
    const local = await collectGitLabProjectWebhookMetric(client, project, options);
    const inherited = await collectGitLabGroupWebhookMetric(client, project, options);
    expect(local.observation).toMatchObject({ kind: "exact", value: 0 });
    expect(inherited).toMatchObject({
      observation: { kind: "exact", value: 2 },
      eventCategories: ["push", "deployment"],
    });
    expect(inherited.observation.scope).toContain(
      "outside the selected namespace are not inspected",
    );
    expect(calls.map((url) => url.pathname)).toEqual([
      "/api/v4/projects/42/hooks",
      "/api/v4/groups/platform%2Fservices/hooks",
      "/api/v4/groups/platform%2Fservices%2Fnested/hooks",
    ]);
  });

  test.each([401, 403, 404])(
    "continues after endpoint HTTP %s, including unavailable paid-tier group hooks",
    async (status) => {
      const { client } = fixture([
        new Response("discard-provider-error", { status }),
        new Response("Premium or Ultimate required", { status }),
        json([]),
      ]);
      const local = await collectGitLabProjectWebhookMetric(client, project, options);
      const group = await collectGitLabGroupWebhookMetric(client, project, options);
      for (const metric of [local, group]) {
        expect(metric).toMatchObject({
          observation: {
            kind: "unavailable",
            reason: status === 404 ? "not-reported" : "forbidden",
          },
          eventCategories: [],
        });
        expect(JSON.stringify(metric)).not.toContain("Premium");
      }
    },
  );

  test("does not inspect unrelated namespaces or ancestors without an admitted namespace", async () => {
    const { client, calls } = fixture([]);
    for (const namespace of [undefined, "platform/service", "other"]) {
      const metric = await collectGitLabGroupWebhookMetric(client, project, { namespace });
      expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "not-reported" });
    }
    expect(calls).toEqual([]);
  });

  test("counts retries and pages against the same budget and retains partial evidence", async () => {
    const { client, calls } = fixture(
      [
        new Response(null, { status: 429 }),
        json([{ id: 1, push_events: true }], { "X-Next-Page": "2" }),
      ],
      1,
    );
    const metric = await collectGitLabProjectWebhookMetric(client, project, {
      ...options,
      apiCallCeiling: 2,
    });
    expect(metric).toMatchObject({
      observation: { kind: "at-least", value: 1, reason: "request-budget" },
      eventCategories: ["push"],
    });
    expect(calls).toHaveLength(2);
    expect(client.getApiCalls()).toBe(2);
    const exhausted = await collectGitLabGroupWebhookMetric(client, project, {
      ...options,
      apiCallCeiling: 2,
    });
    expect(exhausted).toMatchObject({
      observation: { kind: "unavailable", reason: "request-budget" },
      eventCategories: [],
    });
    expect(calls).toHaveLength(2);
  });

  test("preserves known inherited hooks when a sibling group is forbidden", async () => {
    const { client } = fixture([
      new Response(null, { status: 403 }),
      json([{ id: 1, pipeline_events: true }]),
    ]);
    const metric = await collectGitLabGroupWebhookMetric(client, project, options);
    expect(metric).toMatchObject({
      observation: { kind: "at-least", value: 1, reason: "pagination-uncertain" },
      eventCategories: ["pipeline"],
    });
    expect(metric.observation.scope).toContain("forbidden");
  });

  test("retains inherited evidence when the shared budget ends before a descendant group", async () => {
    const { client, calls } = fixture([json([{ id: 1, pipeline_events: true }])]);
    const metric = await collectGitLabGroupWebhookMetric(client, project, {
      ...options,
      apiCallCeiling: 1,
    });
    expect(metric).toMatchObject({
      observation: { kind: "at-least", value: 1, reason: "request-budget" },
      eventCategories: ["pipeline"],
    });
    expect(calls).toHaveLength(1);
  });

  test("reads each shared ancestor once per profile run, even for concurrent projects", async () => {
    const unavailable = { kind: "unavailable", reason: "not-reported" } as const;
    const inventory: SourceNamespaceInventory = {
      version: 1,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.invalid/api/v4",
      namespace: "platform/services",
      projectCount: { kind: "exact", value: 3 },
      projects: ["41", "42", "43"].map((sourceId) => ({
        provider: "gitlab",
        sourceId,
        path: `platform/services/nested/repository-${sourceId}`,
        name: sourceId,
        visibility: "private",
        archived: false,
        defaultBranch: null,
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
      })),
    };
    const run = async (requestBudget: number) => {
      const groupReads: string[] = [];
      const client = new GitLabClient({
        baseUrl: "https://gitlab.invalid",
        token: "offline-fixture",
        maxRetries: 0,
        fetch: async (input) => {
          const url = new URL(input.toString());
          if (url.pathname.includes("/groups/") && url.pathname.endsWith("/hooks")) {
            groupReads.push(`${url.pathname}?page=${url.searchParams.get("page") ?? "1"}`);
            // Yield so concurrent projects reach the same ancestor before it settles.
            await Bun.sleep(1);
            return url.searchParams.get("page") === "2"
              ? json([{ id: 2, merge_requests_events: true }])
              : json([{ id: 1, push_events: true }], { "X-Next-Page": "2" });
          }
          return json([]);
        },
      });
      const enrichment = await collectGitLabProfileEnrichment(client, inventory, {
        concurrency: 3,
        requestBudget,
      });
      return { enrichment, groupReads, calls: client.getApiCalls() };
    };
    const generous = await run(1_000);
    // Two admitted ancestors, two pages each, regardless of how many projects inherit them.
    expect(generous.groupReads).toHaveLength(4);
    expect(new Set(generous.groupReads).size).toBe(4);
    // A budget sized for one read per ancestor is enough for every project.
    const tight = await run(generous.calls);
    expect(tight.groupReads).toHaveLength(4);
    for (const { metrics } of tight.enrichment.projects) {
      expect(metrics.groupWebhooks).toMatchObject({
        observation: { kind: "exact", value: 4 },
        eventCategories: ["push", "merge-requests"],
      });
    }
  });

  test("retains local evidence when access is denied on a later page", async () => {
    const { client } = fixture([
      json([{ id: 1, push_events: true }], { "X-Next-Page": "2" }),
      new Response(null, { status: 403 }),
    ]);
    const metric = await collectGitLabProjectWebhookMetric(client, project, options);
    expect(metric).toMatchObject({
      observation: { kind: "at-least", value: 1, reason: "pagination-uncertain" },
      eventCategories: ["push"],
    });
  });

  test.each([401, 403, 404])(
    "settles the profile and other projects despite HTTP %s webhook access or tier restrictions",
    async (status) => {
      const unavailable = { kind: "unavailable", reason: "not-reported" } as const;
      const inventory: SourceNamespaceInventory = {
        version: 1,
        provider: "gitlab",
        sourceApiUrl: "https://gitlab.invalid/api/v4",
        namespace: "platform/services",
        projectCount: { kind: "exact", value: 2 },
        projects: ["42", "43"].map((sourceId) => ({
          provider: "gitlab",
          sourceId,
          path: `platform/services/repository-${sourceId}`,
          name: sourceId,
          visibility: "private",
          archived: false,
          defaultBranch: null,
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
        })),
      };
      const client = new GitLabClient({
        baseUrl: "https://gitlab.invalid",
        token: "offline-fixture",
        maxRetries: 0,
        fetch: async (input) => {
          const path = new URL(input.toString()).pathname;
          if (path.includes("/groups/") && path.endsWith("/hooks"))
            return new Response("Premium or Ultimate required", { status: 404 });
          if (path.endsWith("/42/hooks")) return new Response("discard-error", { status });
          return json([]);
        },
      });
      const enrichment = await collectGitLabProfileEnrichment(client, inventory);
      expect(enrichment.projects).toHaveLength(2);
      expect(enrichment.projects[0]?.metrics.projectWebhooks.observation).toMatchObject({
        kind: "unavailable",
        reason: status === 404 ? "not-reported" : "forbidden",
      });
      expect(enrichment.projects[1]?.metrics.projectWebhooks.observation).toMatchObject({
        kind: "exact",
        value: 0,
      });
      for (const { metrics } of enrichment.projects) {
        expect(metrics.groupWebhooks.observation).toMatchObject({
          kind: "unavailable",
          reason: "not-reported",
        });
        expect(metrics.branches.observation).toMatchObject({ kind: "exact", value: 0 });
      }
    },
  );

  test.each([null, { id: 0 }, { id: 1, push_events: "true" }])(
    "rejects malformed hook evidence safely (%j)",
    async (hook) => {
      const { client } = fixture([json([hook])]);
      const metric = await collectGitLabProjectWebhookMetric(client, project, options);
      expect(metric).toMatchObject({
        observation: { kind: "unavailable", reason: "malformed" },
        eventCategories: [],
      });
    },
  );

  test("does not count duplicate hook identities as additional evidence", async () => {
    const { client } = fixture([json([{ id: 1 }], { "X-Next-Page": "2" }), json([{ id: 1 }])]);
    const metric = await collectGitLabProjectWebhookMetric(client, project, options);
    expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "malformed" });
  });

  test("rejects malformed or contradictory pagination and unsafe ancestor paths", async () => {
    const { client } = fixture([
      json({ message: "not-an-array" }),
      json([{ id: 1 }], { "X-Total": "2", "X-Next-Page": "" }),
    ]);
    for (let index = 0; index < 2; index++) {
      expect((await collectGitLabProjectWebhookMetric(client, project)).observation).toMatchObject({
        kind: "unavailable",
        reason: "malformed",
      });
    }
    expect(
      (
        await collectGitLabGroupWebhookMetric(
          client,
          { path: "platform/services/../private/api" },
          options,
        )
      ).observation,
    ).toMatchObject({ kind: "unavailable", reason: "malformed" });
  });

  test("propagates cancellation and unexpected provider failures rather than hiding them", async () => {
    const { client } = fixture([new Response(null, { status: 500 })]);
    await expect(collectGitLabProjectWebhookMetric(client, project, options)).rejects.toThrow(
      "HTTP 500",
    );
    await expect(
      collectGitLabProjectWebhookMetric(client, project, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  test("cancels every project waiting on a shared in-flight ancestor read", async () => {
    const controller = new AbortController();
    let reads = 0;
    const client = new GitLabClient({
      baseUrl: "https://gitlab.invalid",
      token: "offline-fixture",
      maxRetries: 0,
      fetch: (_input, init) => {
        reads += 1;
        controller.abort();
        return Promise.reject(init?.signal?.reason ?? new Error("aborted"));
      },
    });
    const shared = {
      namespace: "platform/services",
      signal: controller.signal,
      groupHookCache: new GitLabGroupHookCache(),
    };
    const waiting = ["a", "b"].map((name) =>
      collectGitLabGroupWebhookMetric(client, { path: `platform/services/${name}` }, shared),
    );
    const settled = await Promise.allSettled(waiting);
    expect(settled.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(reads).toBe(1);
  });
});
