import { describe, expect, test } from "bun:test";
import type { SourceNamespaceInventory } from "$lib/source/types";
import { GitLabClient } from "./client";
import { collectGitLabProfileEnrichment } from "./profile";
import {
  collectGitLabInheritedProtectedBranchMetric,
  collectGitLabProtectedBranchMetric,
  collectGitLabProtectedTagMetric,
  GITLAB_INHERITED_PROTECTED_BRANCHES_SCOPE,
  GITLAB_PROTECTED_BRANCHES_SCOPE,
  GITLAB_PROTECTED_TAGS_SCOPE,
  type GitLabProtectionOptions,
} from "./protections";

type Route = Response | (() => Response);

function json(data: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(data, { headers });
}

function status(code: number): () => Response {
  return () => new Response(null, { status: code });
}

/** Serves fixed responses by API path (without `/api/v4`); anything else fails the test. */
function gitlab(routes: Record<string, Route | Route[]>, options: { maxRetries?: number } = {}) {
  const requests: string[] = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "secret-token",
    maxRetries: options.maxRetries ?? 0,
    sleep: async () => {},
    fetch: async (input) => {
      const url = new URL(input.toString());
      const path = url.pathname.replace(/^\/api\/v4/, "");
      requests.push(`${path}${url.search}`);
      const route = routes[path];
      const next = Array.isArray(route) ? route.shift() : route;
      if (!next) throw new Error(`unexpected fetch ${path}`);
      return typeof next === "function" ? next() : next.clone();
    },
  });
  return { client, requests };
}

const nowMs = Date.parse("2026-11-28T09:00:00Z");

function run(namespace: string, apiCallCeiling?: number): GitLabProtectionOptions {
  return { namespace, nowMs, shared: new Map(), apiCallCeiling };
}

describe("GitLab protection rule collectors", () => {
  test("counts wildcard rules once and keeps rules separate from refs", async () => {
    const { client, requests } = gitlab({
      "/projects/42/protected_branches": json([
        { name: "main", inherited: false },
        { name: "release/*", inherited: false },
        { name: "*-stable", inherited: false },
      ]),
      "/projects/42/protected_tags": json([{ name: "v*" }, { name: "release-*" }]),
    });
    const options = run("platform/api");

    const [branches, tags] = await Promise.all([
      collectGitLabProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabProtectedTagMetric(client, { sourceId: "42" }, options),
    ]);

    expect(branches).toEqual({
      provider: "gitlab",
      endpointFamily: "project-protected-branches",
      collectedAt: "2026-11-28T09:00:00.000Z",
      observation: {
        kind: "exact",
        value: 3,
        basis: "enumerated",
        scope: GITLAB_PROTECTED_BRANCHES_SCOPE,
      },
    });
    expect(tags.observation).toEqual({
      kind: "exact",
      value: 2,
      basis: "enumerated",
      scope: GITLAB_PROTECTED_TAGS_SCOPE,
    });
    expect(requests.map((request) => request.split("?")[0])).toEqual([
      "/projects/42/protected_branches",
      "/projects/42/protected_tags",
    ]);
  });

  test("separates group-inherited rules from project rules without counting either twice", async () => {
    const { client, requests } = gitlab({
      "/groups/platform/protected_branches": json([{ name: "main" }, { name: "release/*" }]),
      "/projects/42/protected_branches": json([
        { name: "main", inherited: true },
        { name: "develop", inherited: false },
        // An instance that omits the flag still lists the group rule.
        { name: "release/*" },
      ]),
    });
    const options = run("platform");

    const [own, inherited] = await Promise.all([
      collectGitLabProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "42" }, options),
    ]);

    expect(own.observation).toMatchObject({ kind: "exact", value: 1 });
    expect(inherited).toMatchObject({
      endpointFamily: "protected-branch-inheritance",
      observation: {
        kind: "exact",
        value: 2,
        basis: "enumerated",
        scope: GITLAB_INHERITED_PROTECTED_BRANCHES_SCOPE,
      },
    });
    // Both metrics share one read of each list.
    expect(requests).toHaveLength(2);
  });

  test("reads group rules once per run and only for an authorized top-level group", async () => {
    const projectRules = json([{ name: "main", inherited: true }]);
    const { client, requests } = gitlab({
      "/groups/platform/protected_branches": json([{ name: "main" }]),
      "/projects/1/protected_branches": projectRules,
      "/projects/2/protected_branches": projectRules,
    });
    const options = run("platform");
    for (const sourceId of ["1", "2"]) {
      await collectGitLabInheritedProtectedBranchMetric(client, { sourceId }, options);
    }
    expect(requests.filter((path) => path.startsWith("/groups/"))).toHaveLength(1);

    const subgroup = gitlab({
      "/projects/3/protected_branches": json([{ name: "main", inherited: true }]),
      "/projects/4/protected_branches": json([{ name: "main" }]),
    });
    const scoped = run("platform/services");
    const [flagged, unflagged] = await Promise.all([
      collectGitLabInheritedProtectedBranchMetric(subgroup.client, { sourceId: "3" }, scoped),
      collectGitLabInheritedProtectedBranchMetric(subgroup.client, { sourceId: "4" }, scoped),
    ]);
    expect(subgroup.requests.some((path) => path.startsWith("/groups/"))).toBe(false);
    expect(flagged.observation).toMatchObject({ kind: "exact", value: 1 });
    expect(unflagged.observation).toMatchObject({ kind: "unavailable", reason: "unsupported" });
  });

  test.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not-found-or-hidden"],
  ] as const)("records project HTTP %i as %s instead of zero", async (code, reason) => {
    const { client } = gitlab({
      "/projects/42/protected_branches": status(code),
      "/projects/42/protected_tags": status(code),
      "/groups/platform/protected_branches": status(code),
    });
    const options = run("platform");

    for (const metric of await Promise.all([
      collectGitLabProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabProtectedTagMetric(client, { sourceId: "42" }, options),
    ])) {
      expect(metric.observation).toMatchObject({ kind: "unavailable", reason });
    }
  });

  test.each([
    ["platform", 404, "not-reported"],
    ["platform", 403, "forbidden"],
    ["platform/services", undefined, "unsupported"],
  ] as const)(
    "does not classify unflagged rules in %s when group rules give %p",
    async (namespace, code, reason) => {
      const { client } = gitlab({
        ...(code ? { "/groups/platform/protected_branches": status(code) } : {}),
        "/projects/1/protected_branches": json([
          { name: "develop", inherited: false },
          { name: "release/*" },
        ]),
        "/projects/2/protected_branches": json([
          { name: "main", inherited: true },
          { name: "release/*" },
        ]),
      });
      const options = run(namespace);

      const [own, inherited] = await Promise.all([
        collectGitLabProtectedBranchMetric(client, { sourceId: "1" }, options),
        collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "2" }, options),
      ]);

      // Unflagged "release/*" may be either, so neither count can claim to be exact.
      expect(own.observation).toMatchObject({ kind: "unavailable", reason });
      expect(inherited.observation).toMatchObject({ kind: "unavailable", reason });
    },
  );

  test.each([
    [404, "not-reported"],
    [403, "forbidden"],
    [401, "forbidden"],
  ] as const)(
    "falls back to project inheritance flags when the paid-tier group endpoint returns %i",
    async (code, reason) => {
      const { client } = gitlab({
        "/groups/platform/protected_branches": status(code),
        "/projects/1/protected_branches": json([
          { name: "main", inherited: true },
          { name: "develop", inherited: false },
        ]),
        "/projects/2/protected_branches": json([{ name: "main" }]),
      });
      const options = run("platform");

      const [flagged, own, unflagged] = await Promise.all([
        collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "1" }, options),
        collectGitLabProtectedBranchMetric(client, { sourceId: "1" }, options),
        collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "2" }, options),
      ]);

      expect(flagged.observation).toMatchObject({ kind: "exact", value: 1 });
      expect(own.observation).toMatchObject({ kind: "exact", value: 1 });
      // A Free-tier project reports no flags, so inheritance stays unknown rather than zero.
      expect(unflagged.observation).toMatchObject({ kind: "unavailable", reason });
    },
  );

  test("keeps the profile running when tag rules are forbidden", async () => {
    const inventory: SourceNamespaceInventory = {
      version: 1,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform",
      projectCount: { kind: "exact", value: 1 },
      projects: [
        {
          provider: "gitlab",
          sourceId: "42",
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
          jobArtifactsSizeBytes: { kind: "exact", value: 0 },
          pipelineArtifactsSizeBytes: { kind: "exact", value: 0 },
          snippetsSizeBytes: { kind: "exact", value: 0 },
          containerRegistrySizeBytes: { kind: "exact", value: 0 },
          providerDetails: { provider: "gitlab", emptyRepository: true },
        },
      ],
    };
    const { client } = gitlab({
      "/projects/42/issues": json([], { "X-Total": "0" }),
      "/projects/42/merge_requests": json([], { "X-Total": "0" }),
      "/projects/42/repository/branches": json([{}]),
      "/projects/42/repository/tags": json([{}]),
      "/projects/42/releases": json([]),
      "/projects/42/protected_branches": json([{ name: "main", inherited: false }]),
      "/projects/42/protected_tags": status(403),
      "/groups/platform/protected_branches": json([]),
      "/projects/42": json({ ci_config_path: null, auto_devops_enabled: false }),
      "/projects/42/hooks": json([]),
      "/projects/42/approval_rules": json([]),
      "/projects/42/remote_mirrors": json([]),
      "/projects/42/mirror/pull": json({ enabled: false }),
      "/projects/42/packages": json([]),
      "/groups/platform/hooks": json([]),
      "/projects/42/variables": json([], { "X-Total": "0" }),
      "/groups/platform/variables": json([], { "X-Total": "0" }),
      "/projects/42/members": json([]),
      "/projects/42/members/all": json([]),
      "/groups/platform/members": json([]),
      "/groups/platform/members/all": json([]),
    });

    const enrichment = await collectGitLabProfileEnrichment(client, inventory, { nowMs });

    expect(enrichment.projects[0]?.metrics).toMatchObject({
      tags: { observation: { kind: "exact", value: 1 } },
      protectedBranches: { observation: { kind: "exact", value: 1 } },
      inheritedProtectedBranches: { observation: { kind: "exact", value: 0 } },
      protectedTags: {
        observation: {
          kind: "unavailable",
          reason: "forbidden",
          scope: GITLAB_PROTECTED_TAGS_SCOPE,
        },
      },
    });
  });

  test("records malformed rule lists as unavailable", async () => {
    const { client } = gitlab({
      "/projects/42/protected_tags": json([{ name: "" }]),
      "/projects/42/protected_branches": json([{ name: "main", inherited: "yes" }]),
    });
    const options = run("platform/api");

    for (const metric of await Promise.all([
      collectGitLabProtectedTagMetric(client, { sourceId: "42" }, options),
      collectGitLabProtectedBranchMetric(client, { sourceId: "42" }, options),
    ])) {
      expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "malformed" });
    }
  });
});

describe("GitLab protection rule request budget", () => {
  const fullPage = (inherited?: boolean) =>
    json(
      Array.from({ length: 100 }, (_, index) => ({ name: `rule-${index}`, inherited })),
      { "X-Next-Page": "2" },
    );

  test("makes no request and reports request-budget when nothing remains", async () => {
    const { client, requests } = gitlab({});
    const options = run("platform", client.getApiCalls());

    for (const metric of await Promise.all([
      collectGitLabProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabProtectedTagMetric(client, { sourceId: "42" }, options),
    ])) {
      expect(metric.observation).toMatchObject({ kind: "unavailable", reason: "request-budget" });
    }
    expect(requests).toEqual([]);
  });

  test("keeps partly enumerated rule lists as lower bounds, counting pages and retries", async () => {
    const { client, requests } = gitlab(
      {
        "/projects/42/protected_tags": [status(503), fullPage()],
        "/projects/43/protected_branches": [fullPage(false)],
      },
      { maxRetries: 1 },
    );

    const tags = await collectGitLabProtectedTagMetric(
      client,
      { sourceId: "42" },
      run("platform/api", client.getApiCalls() + 2),
    );
    expect(tags.observation).toEqual({
      kind: "at-least",
      value: 100,
      reason: "request-budget",
      scope: GITLAB_PROTECTED_TAGS_SCOPE,
    });
    expect(client.getApiCalls()).toBe(2);

    const branches = await collectGitLabProtectedBranchMetric(
      client,
      { sourceId: "43" },
      run("platform/api", client.getApiCalls() + 1),
    );
    expect(branches.observation).toMatchObject({ kind: "at-least", value: 100 });
    expect(requests).toHaveLength(3);
  });

  test("keeps inherited group rules a lower bound when the group list runs out of budget", async () => {
    const { client } = gitlab({
      "/projects/42/protected_branches": json([
        { name: "develop", inherited: false },
        { name: "rule-0" },
        { name: "hotfix/*" },
      ]),
      "/groups/platform/protected_branches": [fullPage()],
    });
    const options = run("platform", client.getApiCalls() + 2);

    const [own, inherited] = await Promise.all([
      collectGitLabProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "42" }, options),
    ]);

    // Unflagged "hotfix/*" may be on an unread group page, so only "develop" is certain.
    expect(own.observation).toMatchObject({ kind: "at-least", value: 1, reason: "request-budget" });
    expect(inherited.observation).toMatchObject({
      kind: "at-least",
      value: 100,
      reason: "request-budget",
    });
    expect(client.getApiCalls()).toBe(2);
  });

  test("leaves inheritance unknown when an unflagged project list is cut short", async () => {
    const { client } = gitlab({ "/projects/42/protected_branches": [fullPage()] });
    const options = run("platform/api", client.getApiCalls() + 1);

    const [own, inherited] = await Promise.all([
      collectGitLabProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "42" }, options),
    ]);

    // A subgroup has no readable group list, so unflagged rules cannot be classified at all.
    expect(own.observation).toMatchObject({ kind: "unavailable", reason: "unsupported" });
    expect(inherited.observation).toMatchObject({ kind: "unavailable", reason: "unsupported" });
  });

  test("keeps flagged rules as lower bounds when the group list gets no budget", async () => {
    const { client, requests } = gitlab({
      "/projects/42/protected_branches": json([
        { name: "main", inherited: true },
        { name: "develop", inherited: false },
        { name: "hotfix/*" },
      ]),
    });
    const options = run("platform", client.getApiCalls() + 1);

    const [own, inherited] = await Promise.all([
      collectGitLabProtectedBranchMetric(client, { sourceId: "42" }, options),
      collectGitLabInheritedProtectedBranchMetric(client, { sourceId: "42" }, options),
    ]);

    expect(own.observation).toMatchObject({ kind: "at-least", value: 1, reason: "request-budget" });
    expect(inherited.observation).toMatchObject({
      kind: "at-least",
      value: 1,
      reason: "request-budget",
    });
    expect(requests).toEqual(["/projects/42/protected_branches?page=1&per_page=100"]);
  });

  test("reports no certain project rules when a partly read group list cannot classify them", async () => {
    const { client } = gitlab({
      "/projects/42/protected_branches": json([{ name: "hotfix/*" }]),
      "/groups/platform/protected_branches": [fullPage()],
    });

    const own = await collectGitLabProtectedBranchMetric(
      client,
      { sourceId: "42" },
      run("platform", client.getApiCalls() + 2),
    );

    expect(own.observation).toMatchObject({ kind: "unavailable", reason: "request-budget" });
  });
});

test("still fails the profile on a server error that is not an access or tier outcome", async () => {
  const { client } = gitlab({ "/projects/42/protected_tags": status(500) });

  await expect(
    collectGitLabProtectedTagMetric(client, { sourceId: "42" }, run("platform")),
  ).rejects.toMatchObject({ status: 500 });
});
