import { describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  countByPagination,
  createClients,
  doesOrgExist,
  doesRepoExist,
  getRepoCounts,
  isGhecSource,
  isVersionAtLeast,
  makeThrottleOptions,
  sourceBaseUrl,
} from "./github";

test("scopes the approved TLS policy to the source API and its App authentication", async () => {
  const origin = "https://fixture.invalid:8443";
  const sourceApiUrl = `${origin}/api/v3`;
  const oldPolicy = process.env.GH_ALLOW_INSECURE_SOURCE_TLS;
  using warn = spyOn(console, "warn").mockImplementation(() => {});
  using transport = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
  ) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/access_tokens")) {
      return Response.json(
        {
          token: "fixture-installation",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: "all",
        },
        { status: 201 },
      );
    }
    if (path.endsWith("/archive"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://archives.invalid/fixture" },
      });
    return Response.json({ data: { viewer: { login: "fixture" } } });
  }) as typeof fetch);
  try {
    process.env.GH_ALLOW_INSECURE_SOURCE_TLS = sourceApiUrl;
    const options = {
      sourceApiUrl,
      sourceAuth: { token: "fixture" },
      targetAuth: { token: "fixture" },
    };
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    const approved = createClients({
      ...options,
      sourceAuth: { appId: "111", installationId: 222, privateKey },
      targetApiUrl: sourceApiUrl,
      noSslVerify: true,
    });
    expect(await approved.getSourceToken()).toBe("fixture-installation");
    await approved.source.request("GET /meta");
    await approved.sourceGraphql("{ viewer { login } }");
    const archive = await approved.source.request("GET /archive", {
      request: { redirect: "manual" },
    });
    expect(archive.headers.location).toBe("https://archives.invalid/fixture");
    await approved.source.request(`GET ${origin}/api/v30/meta`);
    await approved.target.request("GET /meta");

    const ordinary = createClients(options);
    await ordinary.source.request("GET /meta");
    expect(() =>
      createClients({ ...options, sourceApiUrl: `${origin}/other/api/v3`, noSslVerify: true }),
    ).toThrow("GH_ALLOW_INSECURE_SOURCE_TLS");
    expect(warn).toHaveBeenCalledTimes(1);

    expect(
      transport.mock.calls.map(([url, init]) => [
        url,
        init?.redirect,
        init && "tls" in init ? init.tls : undefined,
      ]),
    ).toEqual([
      [
        `${sourceApiUrl}/app/installations/222/access_tokens`,
        "error",
        { rejectUnauthorized: false },
      ],
      [`${sourceApiUrl}/meta`, "error", { rejectUnauthorized: false }],
      [`${origin}/api/graphql`, "error", { rejectUnauthorized: false }],
      [`${sourceApiUrl}/archive`, "manual", { rejectUnauthorized: false }],
      [`${origin}/api/v30/meta`, undefined, undefined],
      [`${sourceApiUrl}/meta`, undefined, undefined],
      [`${sourceApiUrl}/meta`, undefined, undefined],
    ]);
  } finally {
    if (oldPolicy === undefined) delete process.env.GH_ALLOW_INSECURE_SOURCE_TLS;
    else process.env.GH_ALLOW_INSECURE_SOURCE_TLS = oldPolicy;
  }
});

/**
 * Minimal Octokit stand-in for the DI-style helpers under test. These take a
 * full `InstanceType<typeof RetryOctokit>` (hundreds of methods, overloaded
 * `request`), which is impractical to construct in a unit test, so the fakes
 * implement only the methods each function calls and are cast at the test
 * boundary. The cast is a third-party-type test double — it silences no
 * production type error (the helpers' real signatures are unchanged).
 */
type FakeClient = Parameters<typeof doesOrgExist>[0];

/** Build an HTTP-style error carrying a numeric `status`, like Octokit throws. */
function httpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

describe("isVersionAtLeast", () => {
  test("treats an equal version as satisfying the minimum", () => {
    expect(isVersionAtLeast("3.15.0", "3.15.0")).toBe(true);
  });

  test("accepts higher major/minor/patch versions", () => {
    expect(isVersionAtLeast("3.16.0", "3.15.0")).toBe(true);
    expect(isVersionAtLeast("4.0.0", "3.15.0")).toBe(true);
    expect(isVersionAtLeast("3.15.1", "3.15.0")).toBe(true);
  });

  test("rejects lower versions", () => {
    expect(isVersionAtLeast("3.14.9", "3.15.0")).toBe(false);
    expect(isVersionAtLeast("2.22.0", "3.15.0")).toBe(false);
  });

  test("compares minor versions numerically, not lexically (3.8 < 3.15)", () => {
    // Lexical string comparison would wrongly rank "3.8" above "3.15".
    expect(isVersionAtLeast("3.8.0", "3.15.0")).toBe(false);
    expect(isVersionAtLeast("3.15.0", "3.8.0")).toBe(true);
  });

  test("handles versions with missing patch segments", () => {
    expect(isVersionAtLeast("3.15", "3.15.0")).toBe(true);
    expect(isVersionAtLeast("3.15", "3.15.1")).toBe(false);
  });

  test("rejects an unparseable version instead of failing open", () => {
    // A non-numeric segment must NOT be treated as satisfying the minimum —
    // the GHES version gate has to fail closed, or checkGhesVersion would let
    // an unverifiable instance through.
    expect(isVersionAtLeast("garbage", "3.15.0")).toBe(false);
    expect(isVersionAtLeast("3.x.0", "3.15.0")).toBe(false);
    expect(isVersionAtLeast("", "3.15.0")).toBe(false);
  });
});

describe("isGhecSource", () => {
  test("true for the github.com API host", () => {
    expect(isGhecSource("https://api.github.com")).toBe(true);
  });

  test("true for a GHE.com data-residency tenant", () => {
    expect(isGhecSource("https://api.acme.ghe.com")).toBe(true);
    expect(isGhecSource("https://acme.ghe.com")).toBe(true);
  });

  test("false for a GHES host", () => {
    expect(isGhecSource("https://ghes.example.com/api/v3")).toBe(false);
  });

  test("false for a self-hosted host containing 'github' (e.g. github.mycompany.com)", () => {
    expect(isGhecSource("https://github.mycompany.com/api/v3")).toBe(false);
  });
});

describe("sourceBaseUrl", () => {
  test("maps the github.com API to github.com", () => {
    expect(sourceBaseUrl("https://api.github.com")).toBe("https://github.com");
  });

  test("maps a GHE.com data-residency API host to its web host", () => {
    expect(sourceBaseUrl("https://api.acme.ghe.com")).toBe("https://acme.ghe.com");
  });

  test("strips a trailing /api/v3 from a GHES URL", () => {
    expect(sourceBaseUrl("https://ghes.example.com/api/v3")).toBe("https://ghes.example.com");
  });

  test("strips a trailing slash", () => {
    expect(sourceBaseUrl("https://ghes.example.com/")).toBe("https://ghes.example.com");
  });
});

describe("makeThrottleOptions", () => {
  const reqOptions = { url: "/repos/acme/widget" };

  test("onRateLimit retries while under the 3-attempt cap", () => {
    using warn = spyOn(console, "warn");
    warn.mockImplementation(() => {});
    const { onRateLimit } = makeThrottleOptions();

    expect(onRateLimit(5, reqOptions, {}, 0)).toBe(true);
    expect(onRateLimit(5, reqOptions, {}, 2)).toBe(true);
  });

  test("onRateLimit stops retrying at the cap", () => {
    using warn = spyOn(console, "warn");
    warn.mockImplementation(() => {});
    const { onRateLimit } = makeThrottleOptions();

    expect(onRateLimit(5, reqOptions, {}, 3)).toBe(false);
    expect(onRateLimit(5, reqOptions, {}, 10)).toBe(false);
  });

  test("onSecondaryRateLimit follows the same retry cap", () => {
    using warn = spyOn(console, "warn");
    warn.mockImplementation(() => {});
    const { onSecondaryRateLimit } = makeThrottleOptions();

    expect(onSecondaryRateLimit(5, reqOptions, {}, 0)).toBe(true);
    expect(onSecondaryRateLimit(5, reqOptions, {}, 2)).toBe(true);
    expect(onSecondaryRateLimit(5, reqOptions, {}, 3)).toBe(false);
  });

  test("logs a warning when a rate limit is hit", () => {
    using warn = spyOn(console, "warn").mockImplementation(() => {});
    const { onRateLimit } = makeThrottleOptions();

    onRateLimit(5, reqOptions, {}, 0);

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("doesOrgExist", () => {
  test("true when the org is fetched successfully", async () => {
    const client = { orgs: { get: async () => ({ data: {} }) } } as unknown as FakeClient;
    expect(await doesOrgExist(client, "acme")).toBe(true);
  });

  test("false when the org returns 404", async () => {
    const client = {
      orgs: {
        get: async () => {
          throw httpError(404);
        },
      },
    } as unknown as FakeClient;
    expect(await doesOrgExist(client, "ghost")).toBe(false);
  });

  test("rethrows non-404 errors (e.g. 500)", async () => {
    const client = {
      orgs: {
        get: async () => {
          throw httpError(500);
        },
      },
    } as unknown as FakeClient;
    await expect(doesOrgExist(client, "acme")).rejects.toThrow(/HTTP 500/);
  });
});

describe("doesRepoExist", () => {
  test("true when the repo is fetched successfully", async () => {
    const client = { repos: { get: async () => ({ data: {} }) } } as unknown as FakeClient;
    expect(await doesRepoExist(client, "acme", "widget")).toBe(true);
  });

  test("false when the repo returns 404", async () => {
    const client = {
      repos: {
        get: async () => {
          throw httpError(404);
        },
      },
    } as unknown as FakeClient;
    expect(await doesRepoExist(client, "acme", "ghost")).toBe(false);
  });

  test("rethrows non-404 errors (e.g. 403)", async () => {
    const client = {
      repos: {
        get: async () => {
          throw httpError(403);
        },
      },
    } as unknown as FakeClient;
    await expect(doesRepoExist(client, "acme", "widget")).rejects.toThrow(/HTTP 403/);
  });
});

describe("countByPagination", () => {
  /** A client whose `request` returns the given headers/data and records args. */
  function client(response: { headers?: Record<string, string>; data?: unknown }) {
    const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    const c = {
      request: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        return { headers: response.headers ?? {}, data: response.data ?? [] };
      },
    } as unknown as Parameters<typeof countByPagination>[0];
    return { c, calls };
  }

  test("reads the rel=last page number as the count", async () => {
    const { c } = client({
      data: [{}],
      headers: {
        link: '<https://api.github.com/x?per_page=1&page=2>; rel="next", <https://api.github.com/x?per_page=1&page=987>; rel="last"',
      },
    });

    expect(await countByPagination(c, "GET /x", {})).toBe(987);
  });

  test("forces a one-item first page regardless of caller params", async () => {
    const { c, calls } = client({ data: [{}] });
    await countByPagination(c, "GET /repos/{owner}/{repo}/commits", {
      owner: "acme",
      repo: "widget",
      page: 2,
      per_page: 100,
    });
    expect(calls[0]?.params).toMatchObject({ owner: "acme", repo: "widget", page: 1, per_page: 1 });
  });

  test("finds page= regardless of its position in the rel=last URL", async () => {
    const { c } = client({
      data: [{}],
      headers: {
        link: '<https://api.github.com/x?page=2&per_page=1>; rel="next", <https://api.github.com/x?page=55&per_page=1>; rel="last"',
      },
    });
    expect(await countByPagination(c, "GET /x", {})).toBe(55);
  });

  test.each([
    [[], '<x?page=2>; rel="next", <x?page=5>; rel="last"'],
    [[{}, {}], '<x?page=2>; rel="next", <x?page=5>; rel="last"'],
    [[{}, {}], ""],
    [[{}], '<x?page=3>; rel="next", <x?page=5>; rel="last"'],
    [[{}], '<x?page=2>; rel="next", <x?page=1>; rel="last"'],
    [[{}], '<x?page=5>; rel="last"'],
    [[{}], "<x?cursor=2>; rel=next"],
    [[{}], '<x?page=2>; rel="next", <x?page=5&per_page=100>; rel="last"'],
    [[{}], '<x?page=2>; rel="next", <x?page=5&page=8>; rel="last"'],
    [[{}], '<x?page=2>; rel="next", <x?page=1>; rel="prev", <x?page=5>; rel="last"'],
  ])("rejects contradictory first-page evidence %j %s", async (data, link) => {
    const { c } = client({ data, headers: { link } });
    await expect(countByPagination(c, "GET /x", {})).rejects.toThrow();
  });

  test("rejects an indeterminate count when there is a next page but no last link", async () => {
    const { c } = client({
      headers: { link: '<https://api.github.com/x?per_page=1&page=2>; rel="next"' },
      data: [{ id: 1 }],
    });
    await expect(countByPagination(c, "GET /x", {})).rejects.toThrow("pagination");
  });

  test("returns 0 when there is no link header and no items", async () => {
    const { c } = client({ headers: {}, data: [] });
    expect(await countByPagination(c, "GET /x", {})).toBe(0);
  });
});

describe("getRepoCounts", () => {
  const graph = (async () => ({
    repository: {
      refs: { totalCount: 2 },
      tags: { totalCount: 1 },
      issues: { totalCount: 3 },
      pullRequests: { totalCount: 4 },
      releases: { totalCount: 5 },
    },
  })) as unknown as Parameters<typeof getRepoCounts>[1];
  const client = (request: () => Promise<unknown>) =>
    ({ request }) as unknown as Parameters<typeof getRepoCounts>[0];

  test("counts paginated commits and returns successful GraphQL counts", async () => {
    const octokit = client(async () => ({
      headers: {
        link: '<https://api.github.com/commits?page=2&per_page=1>; rel="next", <https://api.github.com/commits?page=42&per_page=1>; rel="last"',
      },
      data: [{}],
    }));
    expect(await getRepoCounts(octokit, graph, "acme", "repo")).toEqual({
      commits: 42,
      branches: 2,
      tags: 1,
      issues: 3,
      pullRequests: 4,
      releases: 5,
    });
  });

  test("does not turn failed or incomplete lookups into zero counts", async () => {
    const ok = client(async () => ({ headers: {}, data: [] }));
    const brokenGraph = (async () => {
      throw new Error("graphql unavailable");
    }) as unknown as typeof graph;
    await expect(getRepoCounts(ok, brokenGraph, "acme", "repo")).rejects.toThrow(
      "graphql unavailable",
    );
    await expect(
      getRepoCounts(
        client(async () => {
          throw httpError(403);
        }),
        graph,
        "acme",
        "repo",
      ),
    ).rejects.toThrow("HTTP 403");
    await expect(
      getRepoCounts(
        client(async () => ({
          headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
          data: [{}],
        })),
        graph,
        "acme",
        "repo",
      ),
    ).rejects.toThrow("Cannot determine");
    const invalidGraph = (async () => ({
      repository: {
        refs: { totalCount: -1 },
        tags: { totalCount: 1 },
        issues: { totalCount: 3 },
        pullRequests: { totalCount: 4 },
        releases: { totalCount: 5 },
      },
    })) as unknown as typeof graph;
    await expect(getRepoCounts(ok, invalidGraph, "acme", "repo")).rejects.toThrow(
      "Invalid repository counts",
    );
  });

  test("treats GitHub's empty repository response as zero commits", async () => {
    expect(
      (
        await getRepoCounts(
          client(async () => {
            throw httpError(409);
          }),
          graph,
          "acme",
          "repo",
        )
      ).commits,
    ).toBe(0);
  });
});
