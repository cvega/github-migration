import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { GitLabProjectMetrics, SourceNamespaceInventory } from "$lib/source/types";
import { GitLabClient } from "../client";
import { collectGitLabProfileEnrichment } from "../profile";
import collector from "./ci-variables.collector";
import type { GitLabMetricOptions } from "./types";

const NOW = Date.parse("2026-11-28T08:00:00Z");
const project = {
  sourceId: "42",
  path: "platform/services/nested/api",
  defaultBranch: "main",
  providerDetails: { provider: "gitlab" as const },
};
const options: GitLabMetricOptions = { namespace: "platform/services", nowMs: NOW };

/** Response to a metadata-only request. A noncompliant server may still send a body. */
const headers = (total: number | null, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify([{ key: "CANARY_NAME", value: "canary-secret-value" }]), {
    headers: {
      ...(total === null ? {} : { "X-Total": String(total) }),
      "X-Page": "1",
      "X-Per-Page": "1",
      ...extra,
    },
  });
const status = (code: number) =>
  new Response("canary-secret-value Premium required", { status: code });

interface Seen {
  method: string;
  url: URL;
}

function fixture(responses: Response[], maxRetries = 0) {
  const calls: Seen[] = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.invalid",
    token: "offline-fixture",
    maxRetries,
    sleep: async () => {},
    fetch: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: new URL(input.toString()) });
      const response = responses.shift();
      if (!response) throw new Error("unexpected fixture request");
      return response;
    },
  });
  return { client, calls };
}

type CiVariables = GitLabProjectMetrics["ciVariables"];
const collectFor = async (
  client: GitLabClient,
  stored: typeof project,
  overrides: GitLabMetricOptions,
) => (await collector.collect(client, stored, overrides)) as CiVariables;
const collect = (client: GitLabClient, overrides: Partial<GitLabMetricOptions> = {}) =>
  collectFor(client, project, { ...options, ...overrides });

let log: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  log = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
});
afterEach(() => {
  for (const spy of log) spy.mockRestore();
});

describe("GitLab CI/CD variable counts", () => {
  test("binds the collector to its registered metric key", () => {
    expect(collector.key).toBe("ciVariables");
  });

  test("counts entries from pagination headers alone and never requests the variable list body", async () => {
    // Project and two groups: three environment-scoped entries may share one key.
    const { client, calls } = fixture([headers(3), headers(2), headers(5)]);
    const metric = await collect(client);
    expect(metric).toMatchObject({
      provider: "gitlab",
      endpointFamily: "ci-variables",
      collectedAt: "2026-11-28T08:00:00.000Z",
      observation: { kind: "exact", value: 3, basis: "reported" },
      groupLocal: { kind: "exact", value: 7, basis: "reported" },
    });
    expect(calls.map(({ method }) => method)).toEqual(["HEAD", "HEAD", "HEAD"]);
    expect(calls.map(({ url }) => [url.pathname, url.searchParams.get("per_page")])).toEqual([
      ["/api/v4/projects/42/variables", "1"],
      ["/api/v4/groups/platform%2Fservices/variables", "1"],
      ["/api/v4/groups/platform%2Fservices%2Fnested/variables", "1"],
    ]);
  });

  test("keeps project-local and group-local counts separate", async () => {
    const { client } = fixture([headers(4), headers(0), headers(0)]);
    const metric = await collect(client);
    expect(metric.observation).toMatchObject({ kind: "exact", value: 4 });
    expect(metric.groupLocal).toMatchObject({ kind: "exact", value: 0 });
    expect(metric.observation.scope).toContain("project-local");
    expect(metric.groupLocal.scope).toContain("group-local");
  });

  test("keeps a missing total unavailable even when a second page is announced", async () => {
    const { client } = fixture([headers(null, { "X-Next-Page": "2" }), headers(0), headers(1)]);
    const metric = await collect(client);
    expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "not-reported" });
    expect(metric.observation.scope).toContain("project-local");
    expect(metric.groupLocal).toMatchObject({ kind: "exact", value: 1 });
  });

  test.each([
    ["zero pages", "0", "0"],
    ["one empty page", "0", "1"],
  ])("still reports a valid exact zero total with %s", async (_name, total, pages) => {
    const { client } = fixture([
      headers(0, { "X-Total": total, "X-Total-Pages": pages }),
      headers(0),
      headers(0),
    ]);
    expect((await collect(client)).observation).toMatchObject({
      kind: "exact",
      value: 0,
      basis: "reported",
    });
  });

  test("reports an exact single entry when the page count agrees", async () => {
    const { client } = fixture([headers(1, { "X-Total-Pages": "1" }), headers(0), headers(0)]);
    expect((await collect(client)).observation).toMatchObject({ kind: "exact", value: 1 });
  });

  test("a second page with a reported total is counted exactly", async () => {
    const { client } = fixture([
      headers(120, { "X-Next-Page": "2", "X-Total-Pages": "120" }),
      headers(0),
      headers(0),
    ]);
    expect((await collect(client)).observation).toMatchObject({ kind: "exact", value: 120 });
  });

  test.each([
    ["no total or next page", headers(null)],
    ["a non-numeric total", headers(0, { "X-Total": "many" })],
    ["a total that contradicts the page count", headers(3, { "X-Total-Pages": "9" })],
    ["a response for another page size", headers(3, { "X-Per-Page": "100" })],
    ["a next page with a single entry", headers(1, { "X-Next-Page": "2" })],
    ["an invalid next page", headers(null, { "X-Next-Page": "7" })],
    [
      "an absent total with a next page but one total page",
      headers(null, { "X-Next-Page": "2", "X-Total-Pages": "1" }),
    ],
    [
      "an absent total with a next page but zero total pages",
      headers(null, { "X-Next-Page": "2", "X-Total-Pages": "0" }),
    ],
    [
      "an absent total with several pages but an empty next page",
      headers(null, { "X-Next-Page": "", "X-Total-Pages": "3" }),
    ],
    ["an absent total with a non-numeric page count", headers(null, { "X-Total-Pages": "few" })],
    ["a single entry with zero total pages", headers(1, { "X-Total-Pages": "0" })],
    ["a single entry with two total pages", headers(1, { "X-Total-Pages": "2" })],
    ["an empty total with two total pages", headers(0, { "X-Total-Pages": "2" })],
    ["several entries with one total page", headers(3, { "X-Total-Pages": "1" })],
  ])("never turns %s into a measured count", async (name, response) => {
    const { client } = fixture([response, headers(0), headers(0)]);
    const { observation } = await collect(client);
    expect(observation.kind).toBe("unavailable");
    if (observation.kind === "unavailable") {
      expect(observation.reason).toBe(
        name === "no total or next page" ? "not-reported" : "malformed",
      );
    }
  });

  test.each([401, 403])(
    "records forbidden for HTTP %s on both levels and continues",
    async (code) => {
      const { client, calls } = fixture([status(code), status(code), status(code)]);
      const metric = await collect(client);
      expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "forbidden" });
      expect(metric.groupLocal).toMatchObject({ kind: "unavailable", reason: "forbidden" });
      expect(calls).toHaveLength(3);
      expect(JSON.stringify(metric)).not.toMatch(/canary|Premium/);
    },
  );

  test("records not-reported for HTTP 404, including a tier that does not offer the endpoint", async () => {
    const { client } = fixture([status(404), status(404), status(404)]);
    const metric = await collect(client);
    expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "not-reported" });
    expect(metric.groupLocal).toMatchObject({ kind: "unavailable", reason: "not-reported" });
    expect(JSON.stringify(metric)).not.toMatch(/canary|Premium/);
  });

  test.each([405, 501])(
    "reports unsupported, never falls back to the value-returning list, when HTTP %s refuses the metadata request",
    async (code) => {
      const { client, calls } = fixture([status(code), status(code), status(code)]);
      const metric = await collect(client);
      expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "unsupported" });
      expect(metric.groupLocal).toMatchObject({ kind: "unavailable", reason: "unsupported" });
      expect(calls.every(({ method }) => method === "HEAD")).toBe(true);
    },
  );

  test("keeps counts read from reachable groups as a lower bound when a later group is forbidden", async () => {
    const { client } = fixture([headers(0), headers(2), status(403)]);
    const { groupLocal } = await collect(client);
    expect(groupLocal).toMatchObject({
      kind: "at-least",
      value: 2,
      reason: "pagination-uncertain",
    });
    expect(groupLocal.scope).toContain("incomplete: forbidden");
  });

  test("still fails the profile for server errors it cannot classify", async () => {
    const { client } = fixture([status(500)]);
    await expect(collect(client)).rejects.toThrow("HTTP 500");
  });

  test("honors the shared request budget and reports what it could not read", async () => {
    const { client, calls } = fixture([headers(3), headers(2)]);
    // Two attempts allowed: the project and the first group; the second group is refused.
    const metric = await collect(client, { apiCallCeiling: 2 });
    expect(calls).toHaveLength(2);
    expect(metric.observation).toMatchObject({ kind: "exact", value: 3 });
    expect(metric.groupLocal).toMatchObject({
      kind: "at-least",
      value: 2,
      reason: "request-budget",
    });
    const spent = await collect(client, { apiCallCeiling: 2 });
    expect(calls).toHaveLength(2);
    expect(spent.observation).toMatchObject({ kind: "unavailable", reason: "request-budget" });
    expect(spent.groupLocal).toMatchObject({ kind: "unavailable", reason: "request-budget" });
  });

  test("reads each ancestor group once per run for every project beneath it", async () => {
    const shared = new Map<string, Promise<unknown>>();
    const { client, calls } = fixture([
      headers(1), // project 42
      headers(2), // platform/services
      headers(5), // platform/services/nested
      headers(0), // project 43
    ]);
    const first = await collect(client, { shared });
    const second = await collectFor(
      client,
      { ...project, sourceId: "43", path: "platform/services/nested/web" },
      { ...options, shared },
    );
    expect(first.groupLocal).toMatchObject({ kind: "exact", value: 7 });
    expect(second.groupLocal).toMatchObject({ kind: "exact", value: 7 });
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      "/api/v4/projects/42/variables",
      "/api/v4/groups/platform%2Fservices/variables",
      "/api/v4/groups/platform%2Fservices%2Fnested/variables",
      "/api/v4/projects/43/variables",
    ]);
  });

  test.each([undefined, "platform/service", "other"])(
    "does not inspect groups outside the authorized namespace (%s)",
    async (namespace) => {
      const { client, calls } = fixture([headers(1)]);
      const metric = await collect(client, { namespace });
      expect(calls.map(({ url }) => url.pathname)).toEqual(["/api/v4/projects/42/variables"]);
      expect(metric.groupLocal).toMatchObject({ kind: "unavailable", reason: "not-reported" });
    },
  );

  test("rejects traversal segments in the project path without a group request", async () => {
    const { client, calls } = fixture([headers(1)]);
    const metric = await collectFor(
      client,
      { ...project, path: "platform/services/../api" },
      options,
    );
    expect(calls).toHaveLength(1);
    expect(metric.groupLocal).toMatchObject({ kind: "unavailable", reason: "malformed" });
  });

  test("a project directly in the namespace group reads only that group", async () => {
    const { client, calls } = fixture([headers(1), headers(6)]);
    const metric = await collectFor(client, { ...project, path: "platform/services/api" }, options);
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      "/api/v4/projects/42/variables",
      "/api/v4/groups/platform%2Fservices/variables",
    ]);
    expect(metric.groupLocal).toMatchObject({ kind: "exact", value: 6 });
  });

  test("never retains or logs names or values, even from a response that sends them", async () => {
    const { client } = fixture([headers(1), headers(1), status(403)]);
    const metric = await collect(client);
    const output = JSON.stringify(metric);
    expect(output).not.toMatch(/canary|CANARY|secret/);
    for (const spy of log) expect(spy).not.toHaveBeenCalled();
  });

  test("rethrows an abort instead of recording it as a provider outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = fixture([]);
    await expect(collect(client, { signal: controller.signal })).rejects.toThrow("aborted");
  });
});

describe("profile run integration", () => {
  const inventory = {
    provider: "gitlab",
    sourceApiUrl: "https://gitlab.invalid/api/v4",
    namespace: "platform",
    projects: [project].map((entry) => ({ ...entry, path: "platform/api" })),
  } as unknown as SourceNamespaceInventory;

  test("stores both counts in the enrichment and spends the shared request budget", async () => {
    const methods: string[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.invalid",
      token: "offline-fixture",
      maxRetries: 0,
      sleep: async () => {},
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        methods.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (url.pathname.endsWith("/variables")) return headers(2);
        return new Response("[]", { headers: { "X-Total": "0" } });
      },
    });
    const enrichment = await collectGitLabProfileEnrichment(client, inventory, {
      nowMs: NOW,
      requestBudget: 1_000,
    });
    const stored = enrichment.projects[0]?.metrics.ciVariables;
    expect(stored).toMatchObject({
      observation: { kind: "exact", value: 2 },
      groupLocal: { kind: "exact", value: 2 },
    });
    expect(methods.filter((call) => call.includes("/variables"))).toEqual([
      "HEAD /api/v4/projects/42/variables",
      "HEAD /api/v4/groups/platform/variables",
    ]);
    expect(JSON.stringify(enrichment)).not.toMatch(/canary|secret/);
  });
});
