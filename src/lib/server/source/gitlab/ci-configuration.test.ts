import { describe, expect, test } from "bun:test";
import type { ProfileNumericObservation } from "$lib/source/types";
import {
  collectGitLabCiConfigurationMetric,
  GITLAB_CI_CONFIGURATION_SCOPES,
} from "./ci-configuration";
import { GitLabApiError, GitLabClient } from "./client";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const project = { sourceId: "42", defaultBranch: "main" } as const;

type Reply = Response | (() => Response);

function gitlab(replies: Reply[], options: { maxRetries?: number } = {}) {
  const requests: Array<{ method: string; url: URL }> = [];
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "secret-token",
    maxRetries: options.maxRetries ?? 0,
    sleep: async () => {},
    fetch: async (input, init) => {
      requests.push({ method: init?.method ?? "GET", url: new URL(input.toString()) });
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected fetch");
      return typeof reply === "function" ? reply() : reply;
    },
  });
  return { client, requests };
}

function settings(fields: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ id: 42, ...fields }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const status = (code: number) => new Response(null, { status: code });

async function collect(client: GitLabClient, options: { apiCallCeiling?: number } = {}) {
  const metric = await collectGitLabCiConfigurationMetric(client, project, {
    nowMs: NOW,
    ...options,
  });
  expect(metric.provider).toBe("gitlab");
  expect(metric.endpointFamily).toBe("project-ci-configuration");
  expect(metric.collectedAt).toBe("2026-11-28T12:00:00.000Z");
  return metric.observation;
}

const found = (scope: string) => ({ kind: "exact", value: 1, basis: "reported", scope }) as const;
const none = (scope: string) => ({ kind: "exact", value: 0, basis: "reported", scope }) as const;
const unavailable = (
  reason: Extract<ProfileNumericObservation, { kind: "unavailable" }>["reason"],
) => ({ kind: "unavailable", reason, scope: GITLAB_CI_CONFIGURATION_SCOPES.unknown }) as const;

describe("collectGitLabCiConfigurationMetric", () => {
  test("probes the default config file with a metadata-only HEAD request", async () => {
    const { client, requests } = gitlab([
      settings({
        builds_access_level: "enabled",
        ci_config_path: null,
        auto_devops_enabled: false,
      }),
      new Response("secret: value", { status: 200 }),
    ]);

    expect(await collect(client)).toEqual(found(GITLAB_CI_CONFIGURATION_SCOPES.defaultFound));
    expect(requests.map(({ method, url }) => `${method} ${url.pathname}${url.search}`)).toEqual([
      "GET /api/v4/projects/42",
      "HEAD /api/v4/projects/42/repository/files/.gitlab-ci.yml?ref=HEAD",
    ]);
  });

  test("probes a custom local path without retaining it", async () => {
    const { client, requests } = gitlab([
      settings({ ci_config_path: "build/pipelines/main.yml", auto_devops_enabled: true }),
      status(200),
    ]);

    const observation = await collect(client);

    expect(observation).toEqual(found(GITLAB_CI_CONFIGURATION_SCOPES.customFound));
    expect(JSON.stringify(observation)).not.toContain("pipelines");
    expect(requests[1]?.url.pathname).toBe(
      "/api/v4/projects/42/repository/files/build%2Fpipelines%2Fmain.yml",
    );
  });

  test.each([
    "templates/ci.yml@platform/shared-ci:main",
    "ci.yml@other/project",
    "https://ci.example.net/pipelines/build.yml",
  ])("never requests the cross-project or external reference %p", async (path) => {
    const { client, requests } = gitlab([settings({ ci_config_path: path })]);

    const observation = await collect(client);

    expect(observation).toEqual(found(GITLAB_CI_CONFIGURATION_SCOPES.external));
    expect(JSON.stringify(observation)).not.toContain("example.net");
    expect(requests).toHaveLength(1);
  });

  test.each(["../other/.gitlab-ci.yml", "/etc/ci.yml", "ci//x.yml"])(
    "does not probe the unsafe local path %p",
    async (path) => {
      const { client, requests } = gitlab([settings({ ci_config_path: path })]);

      expect(await collect(client)).toEqual(unavailable("malformed"));
      expect(requests).toHaveLength(1);
    },
  );

  test("distinguishes enabled, disabled and unreported Auto DevOps when no local file exists", async () => {
    for (const [autoDevOps, expected] of [
      [true, found(GITLAB_CI_CONFIGURATION_SCOPES.autoDevOps)],
      [false, none(GITLAB_CI_CONFIGURATION_SCOPES.absent)],
      // Below Maintainer, or where the setting isn't exposed, GitLab omits the field.
      [undefined, unavailable("not-reported")],
    ] as const) {
      const { client } = gitlab([
        settings({ ci_config_path: "", auto_devops_enabled: autoDevOps }),
        status(404),
      ]);
      expect(await collect(client)).toEqual(expected);
    }
  });

  test("records disabled CI/CD without probing the repository", async () => {
    const { client, requests } = gitlab([
      settings({ builds_access_level: "disabled", ci_config_path: null }),
    ]);

    expect(await collect(client)).toEqual(none(GITLAB_CI_CONFIGURATION_SCOPES.disabled));
    expect(requests).toHaveLength(1);
  });

  test("does not guess the config path when the project hides it", async () => {
    const { client, requests } = gitlab([settings({ builds_access_level: "private" })]);

    expect(await collect(client)).toEqual(unavailable("not-reported"));
    expect(requests).toHaveLength(1);
  });

  test("treats an empty repository as having no local file", async () => {
    const { client, requests } = gitlab([
      settings({ ci_config_path: null, auto_devops_enabled: false }),
    ]);

    const metric = await collectGitLabCiConfigurationMetric(
      client,
      {
        sourceId: "42",
        defaultBranch: null,
        providerDetails: { provider: "gitlab", emptyRepository: true },
      },
      { nowMs: NOW },
    );

    expect(metric.observation).toEqual(none(GITLAB_CI_CONFIGURATION_SCOPES.absent));
    expect(requests).toHaveLength(1);
  });

  test.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not-found-or-hidden"],
  ] as const)("records project settings HTTP %p as %p and continues", async (code, reason) => {
    const { client, requests } = gitlab([status(code)]);

    expect(await collect(client)).toEqual(unavailable(reason));
    expect(requests).toHaveLength(1);
  });

  test("records an unreadable local file as forbidden unless Auto DevOps proves CI runs", async () => {
    for (const code of [401, 403]) {
      const hidden = gitlab([settings({ ci_config_path: null }), status(code)]);
      expect(await collect(hidden.client)).toEqual(unavailable("forbidden"));

      const autoDevOps = gitlab([
        settings({ ci_config_path: null, auto_devops_enabled: true }),
        status(code),
      ]);
      expect(await collect(autoDevOps.client)).toEqual(
        found(GITLAB_CI_CONFIGURATION_SCOPES.autoDevOpsUnreadFile),
      );
    }
  });

  test("records malformed project settings", async () => {
    const { client } = gitlab([settings({ ci_config_path: 7 })]);
    expect(await collect(client)).toEqual(unavailable("malformed"));
  });

  test("propagates server failures instead of recording a result", async () => {
    const { client } = gitlab([status(500)]);
    const failure = await collectGitLabCiConfigurationMetric(client, project).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitLabApiError);
    expect((failure as GitLabApiError).status).toBe(500);
  });

  describe("shared request budget", () => {
    test("makes no request once the budget is spent", async () => {
      const { client, requests } = gitlab([]);
      expect(await collect(client, { apiCallCeiling: 0 })).toEqual(unavailable("request-budget"));
      expect(requests).toHaveLength(0);
    });

    test("keeps partial Auto DevOps evidence when the file probe is refused", async () => {
      const { client, requests } = gitlab([
        settings({ ci_config_path: null, auto_devops_enabled: true }),
      ]);

      expect(await collect(client, { apiCallCeiling: 1 })).toEqual({
        kind: "at-least",
        value: 1,
        reason: "request-budget",
        scope: GITLAB_CI_CONFIGURATION_SCOPES.autoDevOpsUnreadFile,
      });
      expect(requests).toHaveLength(1);
    });

    test("counts retries toward the budget", async () => {
      const { client, requests } = gitlab(
        [status(503), settings({ ci_config_path: null, auto_devops_enabled: false })],
        { maxRetries: 2 },
      );

      expect(await collect(client, { apiCallCeiling: 2 })).toEqual(unavailable("request-budget"));
      expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
      expect(client.getApiCalls()).toBe(2);
    });
  });
});
