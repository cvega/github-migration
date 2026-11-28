import { describe, expect, test } from "bun:test";
import { GitLabClient } from "../client";
import { collectGitLabMembers } from "./members.collector";

const project = { sourceId: "42", path: "platform/services/api", defaultBranch: null };
const options = { namespace: "platform", shared: new Map<string, Promise<unknown>>() };
const json = (data: unknown, headers: Record<string, string> = {}) =>
  Response.json(data, { headers });

function fixture(responses: Response[]) {
  const calls: URL[] = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.invalid",
    token: "offline-fixture",
    maxRetries: 0,
    fetch: async (input) => {
      calls.push(new URL(input.toString()));
      const response = responses.shift();
      if (!response) throw new Error("unexpected fixture request");
      return response;
    },
  });
  return { client, calls };
}

describe("GitLab scoped membership evidence", () => {
  test("paginates direct and effective visible members separately without retaining users or adding scopes", async () => {
    const { client, calls } = fixture([
      json([{ id: 1, username: "discard-user", email: "discard-email" }], { "X-Next-Page": "2" }),
      json([{ id: 2 }]),
      json([{ id: 1 }, { id: 2 }, { id: 3 }]),
      json([{ id: 4 }]),
      json([{ id: 4 }, { id: 5 }]),
    ]);
    const metric = await collectGitLabMembers(client, project, { ...options, shared: new Map() });
    expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "unsupported" });
    expect(metric.scopes).toMatchObject([
      {
        kind: "project",
        path: project.path,
        direct: { observation: { kind: "exact", value: 2 } },
        effective: { observation: { kind: "exact", value: 3 } },
      },
      {
        kind: "group",
        path: "platform/services",
        direct: { observation: { kind: "exact", value: 1 } },
        effective: { observation: { kind: "exact", value: 2 } },
      },
    ]);
    expect(calls.map((url) => [url.pathname, url.searchParams.get("page")])).toEqual([
      ["/api/v4/projects/42/members", "1"],
      ["/api/v4/projects/42/members", "2"],
      ["/api/v4/projects/42/members/all", "1"],
      ["/api/v4/groups/platform%2Fservices/members", "1"],
      ["/api/v4/groups/platform%2Fservices/members/all", "1"],
    ]);
    expect(metric.scopes[0]?.effective.observation.scope).toContain("hidden invited members");
    expect(metric.observation.scope).toContain("mannequins are not target access grants");
    expect(JSON.stringify(metric)).not.toMatch(/discard-|username|email|"id"/);
  });

  test.each([401, 403, 404])(
    "continues all optional membership reads after HTTP %s",
    async (status) => {
      const { client, calls } = fixture([
        new Response("discard-error", { status }),
        json([]),
        new Response("discard-error", { status }),
        json([]),
      ]);
      const metric = await collectGitLabMembers(client, project, { ...options, shared: new Map() });
      for (const scope of metric.scopes) {
        expect(scope.direct.observation).toMatchObject({
          kind: "unavailable",
          reason: status === 404 ? "not-reported" : "forbidden",
        });
        expect(scope.effective.observation).toMatchObject({ kind: "exact", value: 0 });
      }
      expect(calls).toHaveLength(4);
    },
  );

  test("records unavailable paid-tier effective group evidence rather than zero or a direct-only audience", async () => {
    const { client } = fixture([
      json([{ id: 1 }]),
      json([{ id: 1 }, { id: 2 }]),
      json([{ id: 3 }]),
      new Response("Premium or Ultimate required", { status: 404 }),
    ]);
    const metric = await collectGitLabMembers(client, project, { ...options, shared: new Map() });
    expect(metric.scopes[1]?.direct.observation).toMatchObject({ kind: "exact", value: 1 });
    expect(metric.scopes[1]?.effective.observation).toMatchObject({
      kind: "unavailable",
      reason: "not-reported",
    });
    expect(JSON.stringify(metric)).not.toContain("Premium");
  });

  test("keeps paginated counts lower bounds when the shared budget is exhausted", async () => {
    const { client, calls } = fixture([json([{ id: 1 }], { "X-Next-Page": "2" })]);
    const metric = await collectGitLabMembers(client, project, {
      ...options,
      shared: new Map(),
      apiCallCeiling: 1,
    });
    expect(metric.scopes[0]?.direct.observation).toMatchObject({
      kind: "at-least",
      value: 1,
      reason: "request-budget",
    });
    expect(metric.scopes[0]?.effective.observation).toMatchObject({
      kind: "unavailable",
      reason: "request-budget",
    });
    expect(metric.scopes[1]?.direct.observation).toMatchObject({
      kind: "unavailable",
      reason: "request-budget",
    });
    expect(calls).toHaveLength(1);
  });

  test("does not inspect projects or groups outside the admitted namespace", async () => {
    const { client, calls } = fixture([]);
    for (const namespace of [undefined, "platform/service", "other"]) {
      const metric = await collectGitLabMembers(client, project, { namespace });
      expect(metric.scopes).toEqual([]);
      expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "not-reported" });
    }
    expect(calls).toEqual([]);
  });

  test("shares parent group counts across concurrent projects without summing them", async () => {
    const calls: string[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.invalid",
      token: "offline-fixture",
      maxRetries: 0,
      fetch: async (input) => {
        calls.push(new URL(input.toString()).pathname);
        await Bun.sleep(1);
        return json([{ id: 1 }]);
      },
    });
    const shared = new Map<string, Promise<unknown>>();
    const metrics = await Promise.all(
      [project, { ...project, sourceId: "43", path: "platform/services/other" }].map((p) =>
        collectGitLabMembers(client, p, { ...options, shared }),
      ),
    );
    expect(calls.filter((path) => path.includes("/groups/"))).toHaveLength(2);
    expect(metrics.map((metric) => metric.scopes[1]?.effective.observation)).toEqual([
      expect.objectContaining({ kind: "exact", value: 1 }),
      expect.objectContaining({ kind: "exact", value: 1 }),
    ]);
  });

  test.each([
    [json([{ id: 1 }, { id: 1 }])],
    [json([{ id: "1" }])],
    [json([{ id: 1 }], { "X-Next-Page": "3" })],
  ])("rejects malformed or contradictory visible member evidence", async (response) => {
    const { client } = fixture([response, json([]), json([]), json([])]);
    const metric = await collectGitLabMembers(client, project, { ...options, shared: new Map() });
    expect(metric.scopes[0]?.direct.observation).toMatchObject({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  test("keeps visible members as a lower bound if access fails on a later page", async () => {
    const { client } = fixture([
      json([{ id: 1 }], { "X-Next-Page": "2" }),
      new Response(null, { status: 403 }),
      json([]),
      json([]),
      json([]),
    ]);
    const metric = await collectGitLabMembers(client, project, { ...options, shared: new Map() });
    expect(metric.scopes[0]?.direct.observation).toMatchObject({
      kind: "at-least",
      value: 1,
      reason: "pagination-uncertain",
      scope: expect.stringContaining("forbidden"),
    });
  });

  test("rejects malformed paths without sending requests", async () => {
    const { client, calls } = fixture([]);
    const metric = await collectGitLabMembers(
      client,
      { ...project, path: "platform/../api" },
      options,
    );
    expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "malformed" });
    expect(calls).toHaveLength(0);
  });

  test("propagates unexpected server failures and cancellation", async () => {
    const { client } = fixture([new Response(null, { status: 500 })]);
    await expect(collectGitLabMembers(client, project, options)).rejects.toMatchObject({
      status: 500,
    });
    const controller = new AbortController();
    controller.abort(new Error("fixture cancelled"));
    await expect(
      collectGitLabMembers(client, project, { ...options, signal: controller.signal }),
    ).rejects.toThrow("GitLab API request aborted");
  });
});
