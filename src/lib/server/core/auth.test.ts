/**
 * Tests for auth config detection, the availability predicates, and the
 * request→App→env priority chain in resolveSourceAuth/resolveTargetAuth.
 *
 * These functions read process.env live, and other test files mutate the same
 * GH_* vars, so each test fully controls the auth env block (saved/restored).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  __setRateLimitDependenciesForTests,
  fetchLiveRateLimits,
  getAuthConfig,
  getCachedLiveRateLimits,
  getFormDefaults,
  getGitHubSourceConfig,
  getSourceClients,
  isCredentialOverrideAllowed,
  isSourceAppConfigured,
  isSourceAuthAvailable,
  isTargetAppConfigured,
  isTargetAuthAvailable,
  resolveSourceAuth,
  resolveTargetAuth,
} from "./auth";
import type { GitHubClient, RateLimitInfo } from "./github";

const AUTH_ENV_KEYS = [
  "GH_SOURCE_PAT",
  "GH_TARGET_PAT",
  "GH_SOURCE_APP_ID",
  "GH_SOURCE_APP_PRIVATE_KEY",
  "GH_SOURCE_APP_INSTALLATION_ID",
  "GH_TARGET_APP_ID",
  "GH_TARGET_APP_PRIVATE_KEY",
  "GH_TARGET_APP_INSTALLATION_ID",
  "GH_ALLOW_CREDENTIAL_OVERRIDE",
  "GH_SOURCE_API_URL",
  "GH_SOURCE_ORG",
  "GH_TARGET_ORG",
];

let saved: Record<string, string | undefined>;
let restoreRateLimitDependencies = () => {};

beforeEach(() => {
  saved = {};
  for (const k of AUTH_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  restoreRateLimitDependencies();
  restoreRateLimitDependencies = () => {};
  for (const k of AUTH_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const PEM = "-----BEGIN KEY-----\nabc\n-----END KEY-----";

function setSourceApp() {
  process.env.GH_SOURCE_APP_ID = "111";
  process.env.GH_SOURCE_APP_PRIVATE_KEY = PEM;
  process.env.GH_SOURCE_APP_INSTALLATION_ID = "222";
}

function setTargetApp() {
  process.env.GH_TARGET_APP_ID = "333";
  process.env.GH_TARGET_APP_PRIVATE_KEY = PEM;
  process.env.GH_TARGET_APP_INSTALLATION_ID = "444";
}

describe("availability predicates", () => {
  test("no env → nothing configured or available", () => {
    expect(isSourceAppConfigured()).toBe(false);
    expect(isSourceAuthAvailable()).toBe(false);
    expect(isTargetAuthAvailable()).toBe(false);
  });

  test("an env PAT makes auth available but not 'app configured'", () => {
    process.env.GH_SOURCE_PAT = "ghp_x";
    expect(isSourceAuthAvailable()).toBe(true);
    expect(isSourceAppConfigured()).toBe(false);
  });

  test("a complete App config counts as configured and available", () => {
    setSourceApp();
    setTargetApp();
    expect(isSourceAppConfigured()).toBe(true);
    expect(isSourceAuthAvailable()).toBe(true);
    expect(isTargetAppConfigured()).toBe(true);
    expect(isTargetAuthAvailable()).toBe(true);
  });

  test("every App credential field is required on both sides", () => {
    for (const missing of ["id", "key", "installation"] as const) {
      process.env.GH_SOURCE_APP_ID = missing === "id" ? "" : "111";
      process.env.GH_SOURCE_APP_PRIVATE_KEY = missing === "key" ? "" : PEM;
      process.env.GH_SOURCE_APP_INSTALLATION_ID = missing === "installation" ? "" : "222";
      process.env.GH_TARGET_APP_ID = missing === "id" ? "" : "333";
      process.env.GH_TARGET_APP_PRIVATE_KEY = missing === "key" ? "" : PEM;
      process.env.GH_TARGET_APP_INSTALLATION_ID = missing === "installation" ? "" : "444";

      expect(isSourceAppConfigured()).toBe(false);
      expect(isSourceAuthAvailable()).toBe(false);
      expect(isTargetAppConfigured()).toBe(false);
      expect(isTargetAuthAvailable()).toBe(false);
    }
  });
});

describe("getAuthConfig", () => {
  test("reads cached live rates without requiring credentials", () => {
    expect(getCachedLiveRateLimits()).toEqual({ source: null, target: null });
  });

  test("reports pat mode with the PAT ceiling when only a PAT is set", () => {
    process.env.GH_SOURCE_PAT = "ghp_x";
    const cfg = getAuthConfig();
    expect(cfg.source.mode).toBe("pat");
    expect(cfg.source.hasEnvPat).toBe(true);
    expect(cfg.source.rateLimit).toBe(5_000);
  });

  test("reports github-app mode with the app ceiling and ids", () => {
    setSourceApp();
    process.env.GH_SOURCE_PAT = "source-pat";
    setTargetApp();
    process.env.GH_TARGET_PAT = "target-pat";
    const cfg = getAuthConfig();
    expect(cfg).toEqual({
      source: {
        mode: "github-app",
        appId: "111",
        installationId: "222",
        hasEnvPat: true,
        rateLimit: 15_000,
      },
      target: {
        mode: "github-app",
        appId: "333",
        installationId: "444",
        hasEnvPat: true,
        rateLimit: 15_000,
      },
    });
  });
});

describe("getGitHubSourceConfig", () => {
  test("reports normalized configured source auth and rejects an invalid URL", () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3/";
    expect(getGitHubSourceConfig()).toEqual({
      apiUrl: "https://ghes.example.com/api/v3",
      authAvailable: true,
    });

    process.env.GH_SOURCE_API_URL = "not-a-url";
    expect(getGitHubSourceConfig()).toEqual({ apiUrl: "", authAvailable: false });
  });

  test("uses the cloud API for a whitespace-only configured URL", () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    process.env.GH_SOURCE_API_URL = "   ";
    expect(getGitHubSourceConfig()).toEqual({
      apiUrl: "https://api.github.com",
      authAvailable: true,
    });
  });
});

describe("getSourceClients", () => {
  test("constructs production clients with the default dependency set", () => {
    process.env.GH_SOURCE_PAT = "source-pat";

    const clients = getSourceClients();

    expect(clients.sourceApiUrl).toBe("https://api.github.com");
    expect(typeof clients.gql).toBe("function");
    expect(clients.rest).toBeDefined();
    expect(clients.getApiCalls()).toBe(0);
  });

  test("passes normalized auth and URL to the client", () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    process.env.GH_SOURCE_API_URL = "  https://ghes.example.com/  ";
    const graphqlClient = () => {};
    const fakeClient = {
      graphql: graphqlClient,
    } as unknown as GitHubClient;
    const created: Array<{ auth: unknown; baseUrl: string }> = [];
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      createSingleClient: (auth, baseUrl) => {
        created.push({ auth, baseUrl });
        return fakeClient;
      },
    });

    const clients = getSourceClients();
    expect(created).toEqual([
      { auth: { token: "source-pat" }, baseUrl: "https://ghes.example.com/api/v3" },
    ]);
    expect(clients).toMatchObject({
      gql: graphqlClient,
      rest: fakeClient,
      sourceApiUrl: "https://ghes.example.com/api/v3",
    });
  });

  test.each(["discovery", "profile"])("counts each REST retry dispatch for %s", async (kind) => {
    process.env.GH_SOURCE_PAT = "source-pat";
    process.env.GH_SOURCE_API_URL = "https://github.invalid";
    using transport = spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ login: "acme" }))
      .mockResolvedValueOnce(Response.json({ message: "Unavailable" }, { status: 503 }));
    const signal = kind === "profile" ? new AbortController().signal : undefined;
    const { rest, getApiCalls } = getSourceClients(signal);

    const response = await rest.orgs.get({ org: "acme" });

    expect(response.data.login).toBe("acme");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(getApiCalls()).toBe(2);
  });

  test("counts REST pagination pages and GraphQL through the same profile client", async () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    process.env.GH_SOURCE_API_URL = "https://github.invalid";
    using transport = spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected fixture request"))
      .mockResolvedValueOnce(
        Response.json([{ name: "first" }], {
          headers: { link: '<https://github.invalid/api/v3/orgs/acme/repos?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(Response.json([{ name: "second" }]))
      .mockResolvedValueOnce(Response.json({ data: { viewer: { login: "acme" } } }));
    const { rest, gql, getApiCalls } = getSourceClients(new AbortController().signal);

    const repos = await rest.paginate(rest.repos.listForOrg, { org: "acme" });
    expect(repos.map(({ name }) => name)).toEqual(["first", "second"]);
    expect(getApiCalls()).toBe(2);

    expect(await gql("{ viewer { login } }")).toEqual({ viewer: { login: "acme" } });
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      "https://github.invalid/api/v3/orgs/acme/repos",
      "https://github.invalid/api/v3/orgs/acme/repos?page=2",
      "https://github.invalid/api/graphql",
    ]);
    expect(getApiCalls()).toBe(3);
  });

  test.each(["discovery", "profile"])(
    "excludes requests aborted before %s dispatch",
    async (kind) => {
      process.env.GH_SOURCE_PAT = "source-pat";
      process.env.GH_SOURCE_API_URL = "https://github.invalid";
      using transport = spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ login: "acme" }),
      );
      const signal = AbortSignal.abort();
      const { rest, getApiCalls } = getSourceClients(kind === "profile" ? signal : undefined);

      await expect(rest.orgs.get({ org: "acme", request: { signal } })).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect(getApiCalls()).toBe(0);
    },
  );

  test("uses cloud defaults and restores a previous client dependency", () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    const selected: string[] = [];
    const fakeClient = {
      graphql: () => {},
    } as unknown as GitHubClient;
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      createSingleClient: () => {
        selected.push("outer");
        return fakeClient;
      },
    });
    const restoreInner = __setRateLimitDependenciesForTests({
      createSingleClient: () => {
        selected.push("inner");
        return fakeClient;
      },
    });

    restoreInner();
    expect(getSourceClients().sourceApiUrl).toBe("https://api.github.com");
    expect(selected).toEqual(["outer"]);
  });
});

describe("fetchLiveRateLimits", () => {
  const sourceRate: RateLimitInfo = {
    limit: 5_000,
    remaining: 4_500,
    resetAt: "2026-08-08T13:00:00.000Z",
  };
  const targetRate: RateLimitInfo = {
    limit: 15_000,
    remaining: 14_000,
    resetAt: "2026-08-08T13:00:00.000Z",
  };

  test("returns empty telemetry without constructing clients when credentials are absent", async () => {
    let clientCalls = 0;
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      createSingleClient: () => {
        clientCalls += 1;
        return {} as GitHubClient;
      },
    });

    expect(await fetchLiveRateLimits()).toEqual({ source: null, target: null });
    expect(getCachedLiveRateLimits()).toEqual({ source: null, target: null });
    expect(clientCalls).toBe(0);
  });

  test("does not cache missing credentials when source auth appears later", async () => {
    let clientCalls = 0;
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      createSingleClient: () => {
        clientCalls += 1;
        return {} as GitHubClient;
      },
      getRateLimit: async () => sourceRate,
    });

    expect(await fetchLiveRateLimits()).toEqual({ source: null, target: null });
    process.env.GH_SOURCE_PAT = "source-pat";
    expect(await fetchLiveRateLimits()).toEqual({ source: sourceRate, target: null });
    expect(clientCalls).toBe(1);
  });

  test("fetches both sides, caches the result, and refreshes after the TTL", async () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    process.env.GH_TARGET_PAT = "target-pat";
    process.env.GH_SOURCE_API_URL = "https://ghes.example/api/v3";
    let now = 1_000_000;
    const clients: Array<{ token: string; baseUrl: string }> = [];
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      now: () => now,
      createSingleClient: (auth, baseUrl) => {
        const token = "token" in auth ? (auth.token ?? "") : "app";
        const client = { token, baseUrl };
        clients.push(client);
        return client as unknown as GitHubClient;
      },
      getRateLimit: async (client) =>
        (client as unknown as { baseUrl: string }).baseUrl.includes("ghes")
          ? sourceRate
          : targetRate,
    });

    const expected = { source: sourceRate, target: targetRate };
    expect(await fetchLiveRateLimits()).toEqual(expected);
    expect(await fetchLiveRateLimits()).toEqual(expected);
    expect(getCachedLiveRateLimits()).toEqual(expected);
    expect(clients).toEqual([
      { token: "source-pat", baseUrl: "https://ghes.example/api/v3" },
      { token: "target-pat", baseUrl: "https://api.github.com" },
    ]);

    now += 30_001;
    expect(await fetchLiveRateLimits()).toEqual(expected);
    expect(clients).toHaveLength(4);
  });

  test("returns the successful side when the other rate-limit request fails", async () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    process.env.GH_TARGET_PAT = "target-pat";
    process.env.GH_SOURCE_API_URL = "https://ghes.example/api/v3";
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      createSingleClient: (_auth, baseUrl) => ({ baseUrl }) as unknown as GitHubClient,
      getRateLimit: async (client) => {
        if ((client as unknown as { baseUrl: string }).baseUrl.includes("ghes")) {
          throw new Error("source offline");
        }
        return targetRate;
      },
    });

    expect(await fetchLiveRateLimits()).toEqual({ source: null, target: targetRate });
    expect(getCachedLiveRateLimits()).toEqual({ source: null, target: targetRate });
  });

  test("fetches only the configured side", async () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    const clients: string[] = [];
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      createSingleClient: (_auth, baseUrl) => {
        clients.push(baseUrl);
        return {} as GitHubClient;
      },
      getRateLimit: async () => sourceRate,
    });

    expect(await fetchLiveRateLimits()).toEqual({ source: sourceRate, target: null });
    expect(clients).toEqual(["https://api.github.com"]);
  });

  test("fetches only the configured target side", async () => {
    process.env.GH_TARGET_PAT = "target-pat";
    const clients: string[] = [];
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      createSingleClient: (_auth, baseUrl) => {
        clients.push(baseUrl);
        return {} as GitHubClient;
      },
      getRateLimit: async () => targetRate,
    });

    expect(await fetchLiveRateLimits()).toEqual({ source: null, target: targetRate });
    expect(clients).toEqual(["https://api.github.com"]);
  });

  test("refreshes at the exact cache expiry boundary", async () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    let now = 10_000;
    let requests = 0;
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      now: () => now,
      createSingleClient: () => ({}) as GitHubClient,
      getRateLimit: async () => {
        requests += 1;
        return sourceRate;
      },
    });

    await fetchLiveRateLimits();
    now += 30_000;
    await fetchLiveRateLimits();
    expect(requests).toBe(2);
  });

  test("reuses the cache with the default clock", async () => {
    process.env.GH_SOURCE_PAT = "source-pat";
    let requests = 0;
    restoreRateLimitDependencies = __setRateLimitDependenciesForTests({
      createSingleClient: () => ({}) as GitHubClient,
      getRateLimit: async () => {
        requests += 1;
        return sourceRate;
      },
    });

    await fetchLiveRateLimits();
    await fetchLiveRateLimits();
    expect(requests).toBe(1);
  });
});

describe("resolveSourceAuth priority", () => {
  test("request token wins over everything", () => {
    setSourceApp();
    process.env.GH_SOURCE_PAT = "env-pat";
    expect(resolveSourceAuth("req-token")).toEqual({ token: "req-token" });
  });

  test("request app wins over env when no request token", () => {
    setSourceApp();
    process.env.GH_SOURCE_PAT = "env-pat";
    const result = resolveSourceAuth(undefined, {
      appId: "9",
      privateKey: PEM,
      installationId: "8",
    });
    expect(result).toEqual({ appId: "9", privateKey: PEM, installationId: 8 });
  });

  test("decodes a base64 request App private key", () => {
    expect(
      resolveSourceAuth(undefined, {
        appId: "9",
        privateKey: Buffer.from(PEM).toString("base64"),
        installationId: "8",
      }),
    ).toEqual({ appId: "9", privateKey: PEM, installationId: 8 });
  });

  test("decodes a base64 environment App private key", () => {
    process.env.GH_SOURCE_APP_ID = "111";
    process.env.GH_SOURCE_APP_PRIVATE_KEY = Buffer.from(PEM).toString("base64");
    process.env.GH_SOURCE_APP_INSTALLATION_ID = "222";

    expect(resolveSourceAuth()).toEqual({ appId: "111", privateKey: PEM, installationId: 222 });
  });

  test("preserves a malformed base64 private key for downstream validation", () => {
    const malformed = "not-base64!!!";
    expect(
      resolveSourceAuth(undefined, {
        appId: "9",
        privateKey: malformed,
        installationId: "8",
      }),
    ).toEqual({ appId: "9", privateKey: malformed, installationId: 8 });
  });

  test("env app is used when no request creds", () => {
    setSourceApp();
    expect(resolveSourceAuth()).toEqual({ appId: "111", privateKey: PEM, installationId: 222 });
  });

  test("env PAT is the last resort before throwing", () => {
    process.env.GH_SOURCE_PAT = "env-pat";
    expect(resolveSourceAuth()).toEqual({ token: "env-pat" });
  });

  test("throws a source-specific error when nothing is available", () => {
    expect(() => resolveSourceAuth()).toThrow(/no source/i);
  });
});

describe("resolveTargetAuth", () => {
  test("throws a target-specific error when nothing is available", () => {
    expect(() => resolveTargetAuth()).toThrow(/no target/i);
  });

  test("uses the target env PAT", () => {
    process.env.GH_TARGET_PAT = "tgt-pat";
    expect(resolveTargetAuth()).toEqual({ token: "tgt-pat" });
  });

  test("uses request token, request App, then env App in priority order", () => {
    setTargetApp();
    process.env.GH_TARGET_PAT = "env-pat";
    const requestApp = { appId: "9", privateKey: PEM, installationId: "8" };

    expect(resolveTargetAuth("request-token", requestApp)).toEqual({ token: "request-token" });
    expect(resolveTargetAuth(undefined, requestApp)).toEqual({
      appId: "9",
      privateKey: PEM,
      installationId: 8,
    });
    expect(resolveTargetAuth()).toEqual({ appId: "333", privateKey: PEM, installationId: 444 });
  });
});

describe("isCredentialOverrideAllowed", () => {
  test("defaults to allowed when unset or empty", () => {
    expect(isCredentialOverrideAllowed()).toBe(true);
    process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = "";
    expect(isCredentialOverrideAllowed()).toBe(true);
    process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = "   ";
    expect(isCredentialOverrideAllowed()).toBe(true);
  });

  test("treats false/0/no/off (any case, padded) as locked", () => {
    for (const v of ["false", "0", "no", "off", "FALSE", " Off "]) {
      process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = v;
      expect(isCredentialOverrideAllowed()).toBe(false);
    }
  });

  test("keeps override allowed for true/1/other values", () => {
    for (const v of ["true", "1", "yes", "anything"]) {
      process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = v;
      expect(isCredentialOverrideAllowed()).toBe(true);
    }
  });
});

describe("getFormDefaults", () => {
  test("returns empty defaults when nothing is configured", () => {
    expect(getFormDefaults()).toEqual({ sourceApiUrl: "", sourceOrgs: [], targetOrgs: [] });
  });

  test("reads and trims the source API URL", () => {
    process.env.GH_SOURCE_API_URL = "  https://ghes.example.com/api/v3  ";
    expect(getFormDefaults().sourceApiUrl).toBe("https://ghes.example.com/api/v3");
  });

  test("drops an invalid source API URL from form defaults", () => {
    process.env.GH_SOURCE_API_URL = "not-a-url";
    expect(getFormDefaults().sourceApiUrl).toBe("");
  });

  test("parses one or many orgs split on commas/whitespace, de-duplicated", () => {
    process.env.GH_SOURCE_ORG = "octo-org";
    process.env.GH_TARGET_ORG = "acme, acme,  beta\ngamma";
    const fd = getFormDefaults();
    expect(fd.sourceOrgs).toEqual(["octo-org"]);
    expect(fd.targetOrgs).toEqual(["acme", "beta", "gamma"]);
  });

  test("drops empty list entries and trims every configured organization", () => {
    process.env.GH_SOURCE_ORG = "  acme,\tplatform  , ,\nacme ";
    process.env.GH_TARGET_ORG = "  target-a target-b  ";

    expect(getFormDefaults()).toMatchObject({
      sourceOrgs: ["acme", "platform"],
      targetOrgs: ["target-a", "target-b"],
    });
  });
});
