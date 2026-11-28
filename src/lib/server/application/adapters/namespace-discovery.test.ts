import { expect, test } from "bun:test";
import { BitbucketServerApiError } from "$lib/server/source/bitbucket/client";
import { GitLabApiError } from "$lib/server/source/gitlab/client";
import type { SourceProvider } from "$lib/source-provider";
import {
  describeDiscoveryFailure,
  describeEmptyDiscovery,
  describeScopeNotice,
  enterpriseNamespaces,
} from "./namespace-discovery";

test("enterprise discovery follows later pages and deduplicates eligible namespaces", async () => {
  const previous = process.env.PROFILE_CONNECTION_SCOPE;
  process.env.PROFILE_CONNECTION_SCOPE = "bitbucket-server";
  try {
    const cursors: number[] = [];
    const keys = await enterpriseNamespaces(
      "bitbucket-server",
      new AbortController().signal,
      "",
      async (_, cursor) => {
        cursors.push(cursor);
        return {
          host: "bitbucket.example",
          observedAt: "now",
          entries: (cursor ? ["AA", "BB"] : ["AA"]).map((key) => ({ key, name: key })),
          next: cursor ? null : 17,
        };
      },
    );
    expect(keys).toEqual({
      keys: ["AA", "BB"],
      found: 2,
      outOfScope: 0,
      scopeVariable: "BITBUCKET_SERVER_PROJECT_KEYS",
    });
    expect(cursors).toEqual([0, 17]);
  } finally {
    if (previous === undefined) delete process.env.PROFILE_CONNECTION_SCOPE;
    else process.env.PROFILE_CONNECTION_SCOPE = previous;
  }
});

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const page = (keys: string[]) => async () => ({
  host: "source.example",
  observedAt: "now",
  entries: keys.map((key) => ({ key, name: key })),
  next: null,
});

test("enterprise discovery counts namespaces removed by the credential scope", () =>
  withEnv(
    {
      PROFILE_CONNECTION_SCOPE: undefined,
      GITLAB_SOURCE_NAMESPACE: "test-group",
      GITLAB_SOURCE_API_URL: "https://gitlab.internal.example/api/v4",
      GITLAB_SOURCE_PAT: "test-token",
    },
    async () => {
      const result = await enterpriseNamespaces(
        "gitlab",
        new AbortController().signal,
        "",
        page(["alpha", "beta", "test-group", "test-group/sub"]),
      );
      expect(result).toEqual({
        keys: ["test-group"],
        found: 4,
        outOfScope: 2,
        scopeVariable: "GITLAB_SOURCE_NAMESPACE",
      });
    },
  ));

test("empty discovery names the scope variable without exposing provider data", () => {
  expect(
    describeEmptyDiscovery("gitlab", {
      keys: [],
      found: 16,
      outOfScope: 16,
      scopeVariable: "GITLAB_SOURCE_NAMESPACE",
    }),
  ).toBe(
    "Discovery found 16 GitLab groups, but all are outside the configured scope (GITLAB_SOURCE_NAMESPACE). No profiles queued.",
  );
  expect(
    describeEmptyDiscovery("bitbucket-server", {
      keys: [],
      found: 0,
      outOfScope: 0,
      scopeVariable: "BITBUCKET_SERVER_PROJECT_KEYS",
    }),
  ).toBe(
    "Discovery found no Bitbucket Server projects visible to the source credentials. No profiles queued.",
  );
  expect(
    describeScopeNotice("github", {
      keys: ["a"],
      found: 3,
      outOfScope: 2,
      scopeVariable: "GH_SOURCE_ORG",
    }),
  ).toBe("2 of 3 GitHub organizations found are outside the configured scope (GH_SOURCE_ORG).");
  expect(
    describeScopeNotice("github", {
      keys: ["a"],
      found: 1,
      outOfScope: 0,
      scopeVariable: "GH_SOURCE_ORG",
    }),
  ).toBeUndefined();
});

function networkError(code: string, name = "TypeError") {
  return Object.assign(
    new Error(`connect ${code} https://user:secret@source.example/api?token=abc`),
    {
      name,
      code,
    },
  );
}

test("discovery failures are classified from wrapped GitHub, GitLab and Bitbucket errors", () => {
  const wrapped = {
    github: (cause: unknown) => Object.assign(new Error("fetch failed"), { status: 500, cause }),
    gitlab: (cause: unknown) => new GitLabApiError(0, "GitLab API request failed", { cause }),
    "bitbucket-server": (cause: unknown) =>
      new BitbucketServerApiError(0, "Bitbucket Server API request failed", { cause }),
  } as const;
  for (const [provider, wrap] of Object.entries(wrapped) as [
    SourceProvider,
    (c: unknown) => Error,
  ][]) {
    expect(describeDiscoveryFailure(provider, wrap(networkError("ENOTFOUND"))).reason).toBe(
      "host_not_resolvable",
    );
    expect(describeDiscoveryFailure(provider, wrap(networkError("EAI_AGAIN"))).reason).toBe(
      "host_not_resolvable",
    );
    expect(
      describeDiscoveryFailure(provider, wrap(networkError("DEPTH_ZERO_SELF_SIGNED_CERT"))).reason,
    ).toBe("tls_untrusted");
    expect(
      describeDiscoveryFailure(provider, wrap(networkError("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")))
        .reason,
    ).toBe("tls_untrusted");
    expect(describeDiscoveryFailure(provider, wrap(networkError("ECONNREFUSED"))).reason).toBe(
      "connection_refused",
    );
    expect(
      describeDiscoveryFailure(provider, wrap(networkError("23", "TimeoutError"))).reason,
    ).toBe("timeout");
  }
  const ghHttp = Object.assign(new Error("Not Found https://api.example/secret"), { status: 404 });
  expect(describeDiscoveryFailure("github", ghHttp)).toMatchObject({
    reason: "http",
    log: "http 404",
  });
  expect(
    describeDiscoveryFailure(
      "gitlab",
      new GitLabApiError(502, "GitLab API request failed with HTTP 502"),
    ),
  ).toMatchObject({
    reason: "http",
    log: "http 502",
  });
  expect(
    describeDiscoveryFailure("bitbucket-server", new BitbucketServerApiError(401, "x")).message,
  ).toBe("Source credentials were rejected. No profiles queued.");
  expect(
    describeDiscoveryFailure("github", Object.assign(new Error("x"), { status: 403 })).message,
  ).toBe("Access to this enterprise was denied. No profiles queued.");
  expect(describeDiscoveryFailure("gitlab", new Error("boom"))).toMatchObject({
    reason: "unknown",
    log: "unknown",
  });
});

test("discovery failure descriptions never echo provider messages, URLs or secrets", () => {
  const errors = [
    Object.assign(new Error("fetch failed"), {
      status: 500,
      cause: networkError("ENOTFOUND"),
    }),
    new GitLabApiError(0, "GitLab API request failed", { cause: networkError("CERT_HAS_EXPIRED") }),
    Object.assign(new Error("Bad credentials https://user:secret@source.example/?token=abc"), {
      status: 418,
    }),
    networkError("SOMETHING_ELSE"),
  ];
  for (const error of errors) {
    const { log, detail, message } = describeDiscoveryFailure("gitlab", error);
    for (const text of [log, detail, message]) {
      expect(text).not.toMatch(/secret|token|source\.example|https?:|Bad credentials|connect /);
    }
  }
});
