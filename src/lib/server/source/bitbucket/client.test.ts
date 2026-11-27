import { describe, expect, test } from "bun:test";
import {
  BitbucketServerApiError,
  BitbucketServerClient,
  encodeBitbucketSegment,
  normalizeBitbucketServerApiUrl,
} from "./client";

type QueuedResponse = Response | Error;

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(responses: QueuedResponse[]) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(input.toString()), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch, calls };
}

function client(responses: QueuedResponse[], overrides = {}) {
  const mocked = mockFetch(responses);
  return {
    mocked,
    client: new BitbucketServerClient({
      baseUrl: "https://bitbucket.example.com",
      username: "migration-user",
      password: "never-print-this",
      fetch: mocked.fetch,
      sleep: async () => {},
      ...overrides,
    }),
  };
}

describe("Bitbucket Server API URL handling", () => {
  test("normalizes a server base URL and existing REST root", () => {
    expect(normalizeBitbucketServerApiUrl("https://bitbucket.example.com/")).toBe(
      "https://bitbucket.example.com/rest/api/1.0",
    );
    expect(normalizeBitbucketServerApiUrl("https://code.example.com/bitbucket/rest/api/1.0/")).toBe(
      "https://code.example.com/bitbucket/rest/api/1.0",
    );
  });

  test("rejects unsafe URLs and path segments", () => {
    expect(() => normalizeBitbucketServerApiUrl("http://bitbucket.local")).toThrow("HTTPS");
    expect(
      normalizeBitbucketServerApiUrl("http://bitbucket.local", { allowInsecureHttp: true }),
    ).toBe("http://bitbucket.local/rest/api/1.0");
    expect(() => normalizeBitbucketServerApiUrl("https://user@bitbucket.example.com")).toThrow(
      "credentials",
    );
    expect(() => normalizeBitbucketServerApiUrl("https://bitbucket.example.com?token=x")).toThrow(
      "credentials",
    );
    expect(encodeBitbucketSegment("PROJ", "project key")).toBe("PROJ");
    expect(() => encodeBitbucketSegment("../PROJ", "project key")).not.toThrow();
    expect(() => encodeBitbucketSegment("..", "project key")).toThrow("path segment");
  });
});

describe("BitbucketServerClient", () => {
  test("keeps basic credentials private and rejects redirects", async () => {
    const { client: api, mocked } = client([jsonResponse({ version: "8.19.0" })]);
    await api.get("/application-properties");

    expect(mocked.calls[0]?.url.toString()).toBe(
      "https://bitbucket.example.com/rest/api/1.0/application-properties",
    );
    expect(new Headers(mocked.calls[0]?.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("migration-user:never-print-this").toString("base64")}`,
    );
    expect(mocked.calls[0]?.init?.redirect).toBe("manual");
    expect(JSON.stringify(api)).not.toContain("never-print-this");

    const redirected = client([new Response(null, { status: 302 })], { maxRetries: 0 }).client;
    await expect(redirected.get("/application-properties")).rejects.toMatchObject({ status: 302 });
  });

  test("constructs exact GET and POST requests without undefined query values", async () => {
    const reading = client([jsonResponse({ ok: true })]);
    await reading.client.get("/projects", { limit: 25, active: true, omitted: undefined });
    const getCall = reading.mocked.calls[0];
    expect(getCall?.init?.method).toBe("GET");
    expect(getCall?.url.search).toBe("?limit=25&active=true");
    expect(new Headers(getCall?.init?.headers).get("accept")).toBe("application/json");
    expect(new Headers(getCall?.init?.headers).get("content-type")).toBeNull();
    expect(getCall?.init?.body).toBeUndefined();

    const writing = client([jsonResponse({ id: 1 })]);
    await writing.client.post("/migration/exports", { repository: "widget" });
    const postCall = writing.mocked.calls[0];
    expect(postCall?.init?.method).toBe("POST");
    expect(new Headers(postCall?.init?.headers).get("content-type")).toBe("application/json");
    expect(postCall?.init?.body).toBe('{"repository":"widget"}');
    expect(writing.client.getApiCalls()).toBe(1);
  });

  test("enforces declared and streamed response byte limits at the exact boundary", async () => {
    const exactDeclared = client([new Response("{}", { headers: { "content-length": "2" } })], {
      maxResponseBytes: 2,
    }).client;
    expect(await exactDeclared.get<Record<string, never>>("/application-properties")).toEqual({});

    let declaredCancelled = false;
    const declaredBody = new ReadableStream({
      cancel() {
        declaredCancelled = true;
      },
    });
    const oversizedDeclared = client(
      [new Response(declaredBody, { headers: { "content-length": "3" } })],
      { maxResponseBytes: 2, maxRetries: 0 },
    ).client;
    await expect(oversizedDeclared.get("/application-properties")).rejects.toThrow(
      "exceeds 2 bytes",
    );
    expect(declaredCancelled).toBe(true);

    const exactStream = client([new Response("{}")], { maxResponseBytes: 2 }).client;
    expect(await exactStream.get<Record<string, never>>("/application-properties")).toEqual({});
    const oversizedStream = client([new Response("{} ")], {
      maxResponseBytes: 2,
      maxRetries: 0,
    }).client;
    await expect(oversizedStream.get("/application-properties")).rejects.toThrow("exceeds 2 bytes");
  });

  test("paginates with forward-only Bitbucket cursors", async () => {
    const { client: api, mocked } = client([
      jsonResponse({ values: [{ id: 1 }], isLastPage: false, nextPageStart: 7 }),
      jsonResponse({ values: [{ id: 2 }], isLastPage: true }),
    ]);

    expect(await api.paginate<{ id: number }>("/projects/PROJ/repos", { limit: 1 })).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    expect(mocked.calls.map((call) => call.url.searchParams.get("start"))).toEqual(["0", "7"]);
  });

  test("validates pagination options and exact collection boundaries", async () => {
    for (const query of [
      { limit: "1" },
      { start: "0" },
      { limit: 0 },
      { start: -1 },
      { limit: 101 },
    ]) {
      const api = client([]).client;
      await expect(api.paginate("/projects", query)).rejects.toBeInstanceOf(TypeError);
      expect(api.getApiCalls()).toBe(0);
    }

    const exact = client([jsonResponse({ values: [1], isLastPage: true })]).client;
    expect(
      await exact.paginate("/projects", { limit: 100 }, { maxItems: 1, maxItemsLabel: "project" }),
    ).toEqual([1]);

    const over = client([jsonResponse({ values: [1, 2], isLastPage: true })]).client;
    await expect(
      over.paginate("/projects", { limit: 100 }, { maxItems: 1, maxItemsLabel: "project" }),
    ).rejects.toThrow("1-project collection limit");
  });

  test("rejects invalid page shapes and backward cursors", async () => {
    for (const page of [
      null,
      [],
      {},
      { values: {}, isLastPage: true },
      { values: [], isLastPage: "true" },
      { values: [1, 2], isLastPage: true },
    ]) {
      const api = client([jsonResponse(page)], { maxRetries: 0 }).client;
      await expect(api.paginate("/projects", { limit: 1 })).rejects.toBeInstanceOf(
        BitbucketServerApiError,
      );
    }

    const backward = client([
      jsonResponse({ values: [1], isLastPage: false, nextPageStart: 7 }),
      jsonResponse({ values: [2], isLastPage: false, nextPageStart: 3 }),
    ]).client;
    await expect(backward.paginate("/projects", { limit: 1 })).rejects.toThrow(
      "invalid nextPageStart",
    );
  });

  test("rejects malformed, non-forward, oversized, and unbounded pagination", async () => {
    for (const page of [
      { values: [], nextPageStart: 1 },
      { values: [], isLastPage: false },
      { values: [], isLastPage: false, nextPageStart: 0 },
      { values: [1, 2], isLastPage: true },
    ]) {
      const api = client([jsonResponse(page)], { maxRetries: 0 }).client;
      await expect(api.paginate("/projects", { limit: 1 })).rejects.toBeInstanceOf(
        BitbucketServerApiError,
      );
    }

    const capped = client([jsonResponse({ values: [1], isLastPage: false, nextPageStart: 1 })], {
      maxPages: 1,
    }).client;
    await expect(capped.paginate("/projects", { limit: 1 })).rejects.toThrow("exceeded 1 pages");

    const limited = client([jsonResponse({ values: [1, 2], isLastPage: true })]).client;
    await expect(
      limited.paginate("/projects", { limit: 2 }, { maxItems: 1, maxItemsLabel: "repository" }),
    ).rejects.toThrow("1-repository collection limit");
  });

  test("retries GET failures but never retries an ambiguous POST", async () => {
    const retrying = client(
      [new TypeError("offline"), jsonResponse({}, 503), jsonResponse({ ok: true })],
      { maxRetries: 2 },
    );
    expect(await retrying.client.get<{ ok: boolean }>("/application-properties")).toEqual({
      ok: true,
    });
    expect(retrying.mocked.calls).toHaveLength(3);

    const writing = client([new TypeError("connection reset"), jsonResponse({ id: 2 })], {
      maxRetries: 2,
    });
    await expect(writing.client.post("/migration/exports", {})).rejects.toThrow(
      "write outcome is unknown",
    );
    expect(writing.mocked.calls).toHaveLength(1);
  });

  const cooldownNowMs = Date.UTC(2026, 7, 8, 12);

  test.each([
    ["numeric", "31"],
    ["HTTP-date", new Date(cooldownNowMs + 31_000).toUTCString()],
  ])("honors %s Retry-After within the retry budget and stops above it", async (_, value) => {
    const delays: number[] = [];
    const options = {
      now: () => cooldownNowMs,
      sleep: async (milliseconds: number) => {
        delays.push(milliseconds);
      },
    };
    const retrying = client(
      [jsonResponse({}, 503, { "retry-after": value }), jsonResponse({ ok: true })],
      { ...options, maxRetryDelayMs: 31_000 },
    );
    expect(await retrying.client.get("/application-properties")).toEqual({ ok: true });
    expect(delays).toEqual([31_000]);
    expect(retrying.mocked.calls).toHaveLength(2);

    const deferred = client(
      [jsonResponse({}, 429, { "retry-after": value }), jsonResponse({ unexpected: true })],
      options,
    );
    await expect(deferred.client.get("/application-properties")).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("cooldown beyond the retry delay budget"),
    });
    expect(deferred.mocked.calls).toHaveLength(1);
    expect(delays).toEqual([31_000]);
  });

  test("stops when a cooldown would overflow the retry timer", async () => {
    const throttled = client(
      [jsonResponse({}, 429, { "retry-after": "2147484" }), jsonResponse({ unexpected: true })],
      { maxRetryDelayMs: 2_147_484_000 },
    );
    await expect(throttled.client.get("/application-properties")).rejects.toMatchObject({
      status: 429,
    });
    expect(throttled.mocked.calls).toHaveLength(1);
  });

  test("bounds the retry count and fallback delay", async () => {
    const delays: number[] = [];
    const bounded = client([jsonResponse({}, 503), jsonResponse({}, 503)], {
      maxRetries: 1,
      maxRetryDelayMs: 100,
      random: () => 0.5,
      sleep: async (milliseconds: number) => {
        delays.push(milliseconds);
      },
    });
    await expect(bounded.client.get("/application-properties")).rejects.toMatchObject({
      status: 503,
    });
    expect(bounded.mocked.calls).toHaveLength(2);
    expect(delays).toEqual([100]);
  });

  test("aborts during a provider cooldown without dispatching again", async () => {
    const controller = new AbortController();
    const cancelled = client([jsonResponse({}, 503, { "retry-after": "2" })], {
      maxRetries: 2,
      sleep: async (_milliseconds: number, signal?: AbortSignal) => {
        controller.abort();
        signal?.throwIfAborted();
      },
    });
    await expect(
      cancelled.client.get("/application-properties", {}, { signal: controller.signal }),
    ).rejects.toThrow("request aborted");
    expect(cancelled.mocked.calls).toHaveLength(1);
  });

  test("creates and reads a repository export with the upstream payload", async () => {
    const { client: api, mocked } = client([
      jsonResponse({ id: 42 }),
      jsonResponse({
        id: 42,
        state: "RUNNING",
        progress: { message: "Exporting", percentage: 35 },
      }),
    ]);

    expect(await api.startRepositoryExport("PLATFORM", "widget")).toBe("42");
    expect(JSON.parse(String(mocked.calls[0]?.init?.body))).toEqual({
      repositoriesRequest: {
        includes: [{ projectKey: "PLATFORM", slug: "widget" }],
      },
    });
    expect(await api.getRepositoryExport("42")).toEqual({
      id: "42",
      state: "RUNNING",
      message: "Exporting",
      percentage: 35,
    });
  });

  test("rejects malformed export identities and progress", async () => {
    await expect(
      client([jsonResponse({ id: 0 })]).client.startRepositoryExport("P", "r"),
    ).rejects.toThrow("export ID was invalid");
    expect(() => client([]).client.getRepositoryExport("../1")).toThrow("positive integer");
    await expect(
      client([
        jsonResponse({ state: "RUNNING", progress: { percentage: 101 } }),
      ]).client.getRepositoryExport("1"),
    ).rejects.toThrow("percentage was invalid");
  });

  test("bounds response bodies, rejects unsafe paths, and honors cancellation", async () => {
    const oversized = client([new Response('{"ok":true}', { status: 200 })], {
      maxResponseBytes: 4,
      maxRetries: 0,
    }).client;
    await expect(oversized.get("/application-properties")).rejects.toThrow("exceeds 4 bytes");

    const api = client([]).client;
    expect(() => api.get("//attacker.example/path")).toThrow("same-origin");
    expect(() => api.get("/../application-properties")).toThrow("dot segments");
    expect(() => api.get("/%252e%252e/application-properties")).toThrow("dot segments");

    const controller = new AbortController();
    controller.abort();
    await expect(
      api.get("/application-properties", {}, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(api.getApiCalls()).toBe(0);
  });

  test("rejects invalid JSON and hides credentials in errors", async () => {
    const api = client([new Response("not-json", { status: 200 })], { maxRetries: 0 }).client;
    try {
      await api.get("/application-properties");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BitbucketServerApiError);
      expect(String(error)).not.toContain("never-print-this");
    }
  });
});
