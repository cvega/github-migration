import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeGitLabPath, GitLabApiError, GitLabClient, normalizeGitLabApiUrl } from "./client";

type QueuedResponse = Response | Error;

function jsonResponse(
  data: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
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

describe("GitLab API URL and path handling", () => {
  test("normalizes cloud and self-managed instance URLs", () => {
    expect(normalizeGitLabApiUrl("https://gitlab.com")).toBe("https://gitlab.com/api/v4");
    expect(normalizeGitLabApiUrl("https://code.example.com/gitlab/")).toBe(
      "https://code.example.com/gitlab/api/v4",
    );
    expect(normalizeGitLabApiUrl("https://code.example.com/api/v4/")).toBe(
      "https://code.example.com/api/v4",
    );
  });

  test("rejects unsafe base URLs", () => {
    expect(() => normalizeGitLabApiUrl("file:///tmp/gitlab")).toThrow("HTTP or HTTPS");
    expect(() => normalizeGitLabApiUrl("http://code.example.com")).toThrow("must use HTTPS");
    expect(normalizeGitLabApiUrl("http://code.example.com", { allowInsecureHttp: true })).toBe(
      "http://code.example.com/api/v4",
    );
    expect(() => normalizeGitLabApiUrl("https://token@code.example.com")).toThrow(
      "must not include credentials",
    );
    expect(() => normalizeGitLabApiUrl("https://code.example.com?token=x")).toThrow(
      "must not include credentials",
    );
    expect(() => normalizeGitLabApiUrl("https://code.example.com#fragment")).toThrow(
      "must not include credentials",
    );
  });

  test("encodes a full nested namespace as one API path segment", () => {
    expect(encodeGitLabPath("platform/services/widget")).toBe("platform%2Fservices%2Fwidget");
    expect(() => encodeGitLabPath("platform//widget")).toThrow("non-empty");
    expect(() => encodeGitLabPath("platform/../widget")).toThrow("non-empty");
  });
});

describe("GitLabClient", () => {
  test("starts, polls, and downloads a nested project export", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ message: "202 Accepted" }, { status: 202 }),
      jsonResponse({ export_status: "finished" }),
      new Response("archive-data", {
        headers: { "Content-Length": "12", "Content-Type": "application/gzip" },
      }),
    ]);
    const client = new GitLabClient({ baseUrl: "https://gitlab.example.com", token: "pat", fetch });
    const directory = await mkdtemp(join(tmpdir(), "gitlab-export-"));
    const archivePath = join(directory, "export.tar.gz");

    try {
      await client.startProjectExport("platform/services/widget");
      expect(await client.getProjectExport("platform/services/widget")).toEqual({
        state: "finished",
      });
      await client.downloadProjectExport("platform/services/widget", archivePath, {
        maxBytes: 1024,
        timeoutMs: 1_000,
      });

      expect(await Bun.file(archivePath).text()).toBe("archive-data");
      expect(calls.map((call) => call.url.pathname)).toEqual([
        "/api/v4/projects/platform%2Fservices%2Fwidget/export",
        "/api/v4/projects/platform%2Fservices%2Fwidget/export",
        "/api/v4/projects/platform%2Fservices%2Fwidget/export/download",
      ]);
      expect(calls.map((call) => call.init?.method)).toEqual(["POST", "GET", "GET"]);
      expect(new Headers(calls[0]?.init?.headers).get("private-token")).toBe("pat");
      expect(calls[0]?.init?.body).toBe("{}");
      expect(calls.every((call) => call.init?.redirect === "manual")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects invalid export states and oversized archives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitlab-oversized-export-"));
    const archivePath = join(directory, "not-written.tar.gz");
    try {
      const invalid = new GitLabClient({
        baseUrl: "https://gitlab.example.com",
        token: "pat",
        fetch: mockFetch([jsonResponse({ export_status: "mystery" })]).fetch,
      });
      await expect(invalid.getProjectExport("group/project")).rejects.toThrow(
        "export status was invalid",
      );

      const oversized = new GitLabClient({
        baseUrl: "https://gitlab.example.com",
        token: "pat",
        fetch: mockFetch([new Response("archive-data", { headers: { "Content-Length": "12" } })])
          .fetch,
      });
      await expect(
        oversized.downloadProjectExport("group/project", archivePath, {
          maxBytes: 4,
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("exceeds 4 bytes");
      expect(await Bun.file(archivePath).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not retry an ambiguous export creation", async () => {
    const { fetch, calls } = mockFetch([new TypeError("connection reset")]);
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "pat",
      fetch,
      maxRetries: 3,
    });

    await expect(client.startProjectExport("group/project")).rejects.toThrow("outcome is unknown");
    expect(calls).toHaveLength(1);
  });

  test("accepts a successful export creation without depending on its response body", async () => {
    const client = new GitLabClient({
      baseUrl: "https://gitlab.example.com",
      token: "pat",
      fetch: mockFetch([new Response("", { status: 202 })]).fetch,
    });

    await expect(client.startProjectExport("group/project")).resolves.toBeUndefined();
  });

  test("keeps credentials private and captures rate-limit telemetry", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse(
        { id: 1 },
        {
          headers: {
            "RateLimit-Limit": "600",
            "RateLimit-Remaining": "599",
            "RateLimit-Reset": "1786219200",
          },
        },
      ),
    ]);
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "secret-token",
      fetch,
    });

    await client.get("/version");

    expect(calls[0]?.url.toString()).toBe("https://gitlab.com/api/v4/version");
    expect(new Headers(calls[0]?.init?.headers).get("private-token")).toBe("secret-token");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(client.getApiCalls()).toBe(1);
    expect(client.getRateLimit()).toEqual({
      limit: 600,
      remaining: 599,
      reset: "1786219200",
      retryAfterSeconds: null,
    });
    expect("token" in client).toBe(false);
  });

  test("enforces HTTPS through the client constructor unless explicitly opted out", () => {
    expect(() => new GitLabClient({ baseUrl: "http://gitlab.local", token: "token" })).toThrow(
      "must use HTTPS",
    );
    expect(
      new GitLabClient({
        baseUrl: "http://gitlab.local",
        token: "token",
        allowInsecureHttp: true,
      }).apiUrl,
    ).toBe("http://gitlab.local/api/v4");
    expect(
      () =>
        new GitLabClient({
          baseUrl: "http://gitlab.local",
          token: "token",
          allowInsecureHttp: "false" as unknown as boolean,
        }),
    ).toThrow("must use HTTPS");
  });

  test("paginates with GitLab headers and preserves nested group filters", async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse([{ id: 1 }, { id: 2 }], { headers: { "X-Next-Page": "2" } }),
      jsonResponse([{ id: 3 }], { headers: { "X-Next-Page": "" } }),
    ]);
    const client = new GitLabClient({
      baseUrl: "https://code.example.com/api/v4",
      token: "token",
      fetch,
    });

    const projects = await client.paginate<{ id: number }>(
      `/groups/${encodeGitLabPath("platform/services")}/projects`,
      { include_subgroups: true, statistics: true, per_page: 2 },
    );

    expect(projects.map((project) => project.id)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(calls[0]?.url.pathname).toBe("/api/v4/groups/platform%2Fservices/projects");
    expect(calls[0]?.url.searchParams.get("include_subgroups")).toBe("true");
    expect(calls[0]?.url.searchParams.get("statistics")).toBe("true");
  });

  test("honors an explicit terminal page and falls back when pagination headers are absent", async () => {
    const terminal = mockFetch([
      jsonResponse([{ id: 1 }, { id: 2 }], { headers: { "X-Next-Page": "" } }),
    ]);
    const terminalClient = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: terminal.fetch,
      maxPages: 1,
    });
    expect(await terminalClient.paginate("/projects", { per_page: 2 })).toHaveLength(2);
    expect(terminal.calls).toHaveLength(1);

    const fallback = mockFetch([jsonResponse([{ id: 1 }, { id: 2 }]), jsonResponse([{ id: 3 }])]);
    const fallbackClient = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: fallback.fetch,
    });
    expect(await fallbackClient.paginate("/projects", { per_page: 2 })).toHaveLength(3);
    expect(fallback.calls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  test("rejects changing and incomplete totals during pagination", async () => {
    const changed = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([
        jsonResponse([{ id: 1 }], { headers: { "X-Next-Page": "2", "X-Total": "2" } }),
        jsonResponse([{ id: 2 }], { headers: { "X-Next-Page": "", "X-Total": "3" } }),
      ]).fetch,
    });
    await expect(changed.paginate("/projects", { per_page: 1 })).rejects.toThrow(
      "changed during pagination",
    );

    const incomplete = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([
        jsonResponse([{ id: 1 }], { headers: { "X-Next-Page": "", "X-Total": "2" } }),
      ]).fetch,
    });
    await expect(incomplete.paginate("/projects")).rejects.toThrow("did not match X-Total");
  });

  test("enforces page shape, total headers, and exact collection limits", async () => {
    const invalidPage = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([jsonResponse({ values: [] })]).fetch,
    });
    await expect(invalidPage.paginate("/projects")).rejects.toThrow("page was not an array");

    const invalidTotal = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([jsonResponse([], { headers: { "X-Total": "unknown" } })]).fetch,
    });
    await expect(invalidTotal.paginate("/projects")).rejects.toThrow("invalid X-Total");

    const declaredOver = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([
        jsonResponse([{ id: 1 }], { headers: { "X-Next-Page": "", "X-Total": "2" } }),
      ]).fetch,
    });
    await expect(declaredOver.paginate("/projects", {}, { maxItems: 1 })).rejects.toThrow(
      "1-item collection limit",
    );

    const cumulativeOver = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([
        jsonResponse([{ id: 1 }], { headers: { "X-Next-Page": "2" } }),
        jsonResponse([{ id: 2 }], { headers: { "X-Next-Page": "" } }),
      ]).fetch,
    });
    await expect(
      cumulativeOver.paginate("/projects", { per_page: 1 }, { maxItems: 1 }),
    ).rejects.toThrow("1-item collection limit");

    const complete: Array<[number | null, number]> = [];
    const exact = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([
        jsonResponse([{ id: 1 }], { headers: { "X-Next-Page": "2", "X-Total": "2" } }),
        jsonResponse([{ id: 2 }], { headers: { "X-Next-Page": "", "X-Total": "2" } }),
      ]).fetch,
    });
    expect(
      await exact.paginate(
        "/projects",
        { per_page: 1 },
        {
          maxItems: 2,
          maxItemsLabel: "project",
          onPaginationComplete: (total, itemsRead) => complete.push([total, itemsRead]),
        },
      ),
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect(complete).toEqual([[2, 2]]);
  });

  test("rejects malformed and non-forward pagination headers", async () => {
    for (const nextPage of ["later", "1"]) {
      const client = new GitLabClient({
        baseUrl: "https://gitlab.com",
        token: "token",
        fetch: mockFetch([jsonResponse([{ id: 1 }], { headers: { "X-Next-Page": nextPage } })])
          .fetch,
      });
      await expect(client.paginate("/projects")).rejects.toThrow("invalid X-Next-Page");
    }
  });

  test("streams pages and enforces pagination and query bounds", async () => {
    const limited = mockFetch([jsonResponse([1]), jsonResponse([2])]);
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: limited.fetch,
      maxPages: 2,
    });
    const pages: number[][] = [];
    await expect(async () => {
      for await (const page of client.paginatePages<number>("/projects", { per_page: 1 })) {
        pages.push(page);
      }
    }).toThrow("exceeded 2 pages");
    expect(pages).toEqual([[1], [2]]);
    expect(limited.calls).toHaveLength(2);

    await expect(client.paginate("/projects", { per_page: 101 })).rejects.toThrow(
      "must not exceed 100",
    );
    await expect(client.paginate("/projects", { page: "2" })).rejects.toThrow(
      "page must be a number",
    );
  });

  test("retries throttling without exposing the token in errors", async () => {
    const { fetch } = mockFetch([
      jsonResponse({ message: "slow down" }, { status: 429, headers: { "Retry-After": "2" } }),
      jsonResponse([{ id: 1 }]),
    ]);
    const delays: number[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "never-print-this",
      fetch,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect((await client.get<Array<{ id: number }>>("/projects")).data).toEqual([{ id: 1 }]);
    expect(delays).toEqual([2_000]);
    expect(client.getApiCalls()).toBe(2);

    const failing = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "never-print-this",
      maxRetries: 0,
      fetch: mockFetch([jsonResponse({}, { status: 500 })]).fetch,
    });
    try {
      await failing.get("/projects");
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GitLabApiError);
      expect(String(error)).not.toContain("never-print-this");
    }
  });

  test("retries network and server failures within validated bounds", async () => {
    const retrying = mockFetch([
      new TypeError("network down"),
      jsonResponse({}, { status: 502 }),
      jsonResponse({ ok: true }),
    ]);
    const delays: number[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: retrying.fetch,
      maxRetries: 2,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect((await client.get<{ ok: boolean }>("/version")).data.ok).toBe(true);
    expect(delays).toEqual([250, 500]);
    expect(client.getApiCalls()).toBe(3);

    for (const options of [
      { maxRetries: -1 },
      { maxRetries: Number.POSITIVE_INFINITY },
      { maxPages: 1.5 },
      { requestTimeoutMs: 0 },
      { maxRetryDelayMs: 0 },
    ]) {
      expect(
        () => new GitLabClient({ baseUrl: "https://gitlab.com", token: "token", ...options }),
      ).toThrow("must be an integer");
    }
  });

  test("stops after the configured number of network and server retries", async () => {
    const network = mockFetch([
      new TypeError("offline"),
      new TypeError("offline"),
      new TypeError("offline"),
    ]);
    const networkClient = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: network.fetch,
      maxRetries: 2,
      random: () => 0.5,
      sleep: async () => {},
    });
    await expect(networkClient.get("/version")).rejects.toMatchObject({ status: 0 });
    expect(network.calls).toHaveLength(3);

    const server = mockFetch([
      jsonResponse({}, { status: 502 }),
      jsonResponse({}, { status: 502 }),
      jsonResponse({}, { status: 502 }),
    ]);
    const serverClient = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: server.fetch,
      maxRetries: 2,
      random: () => 0.5,
      sleep: async () => {},
    });
    await expect(serverClient.get("/version")).rejects.toMatchObject({ status: 502 });
    expect(server.calls).toHaveLength(3);
  });

  test("caps retry delays and supports caller cancellation", async () => {
    const throttled = mockFetch([
      jsonResponse({}, { status: 429, headers: { "Retry-After": "999999" } }),
      jsonResponse({ ok: true }),
    ]);
    const delays: number[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: throttled.fetch,
      maxRetryDelayMs: 100,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    await client.get("/version");
    expect(delays).toEqual([100]);

    const cancelled = mockFetch([jsonResponse({ unexpected: true })]);
    const cancelledClient = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: cancelled.fetch,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelledClient.get("/projects", {}, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(cancelled.calls).toHaveLength(0);
  });

  test("times out a stalled request", async () => {
    const fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch,
      maxRetries: 0,
      requestTimeoutMs: 1,
    });

    await expect(client.get("/version")).rejects.toMatchObject({ status: 0 });
    expect(client.getApiCalls()).toBe(1);
  });

  test("aborts an active request and a retry backoff without dispatching again", async () => {
    const activeSignals: AbortSignal[] = [];
    const activeFetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        if (init?.signal) activeSignals.push(init.signal);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const activeClient = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: activeFetch,
      maxRetries: 2,
    });
    const activeController = new AbortController();
    const activeRequest = activeClient.get("/version", {}, { signal: activeController.signal });
    activeController.abort();
    await expect(activeRequest).rejects.toThrow("aborted");
    expect(activeSignals[0]?.aborted).toBe(true);
    expect(activeClient.getApiCalls()).toBe(1);

    let enteredBackoff: (() => void) | null = null;
    const backoffStarted = new Promise<void>((resolve) => {
      enteredBackoff = resolve;
    });
    const backoff = mockFetch([jsonResponse({}, { status: 503 })]);
    const backoffClient = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: backoff.fetch,
      maxRetries: 2,
      sleep: (_milliseconds, signal) =>
        new Promise((_resolve, reject) => {
          enteredBackoff?.();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    const backoffController = new AbortController();
    const backoffRequest = backoffClient.get("/version", {}, { signal: backoffController.signal });
    await backoffStarted;
    backoffController.abort();
    await expect(backoffRequest).rejects.toBeInstanceOf(GitLabApiError);
    expect(backoff.calls).toHaveLength(1);
  });

  test("rejects redirects, dot segments, and malformed JSON without following them", async () => {
    const redirected = mockFetch([
      new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example/collect" },
      }),
    ]);
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "secret-token",
      fetch: redirected.fetch,
      maxRetries: 0,
    });

    await expect(client.get("/projects")).rejects.toMatchObject({ status: 302 });
    expect(redirected.calls).toHaveLength(1);
    expect(() => client.get("//attacker.example/projects")).toThrow("same-origin");
    expect(() => client.get("/../version")).toThrow("dot segments");
    expect(() => client.get("/%2e%2e/version")).toThrow("dot segments");
    expect(() => client.get("/%252e%252e/version")).toThrow("dot segments");
    let deeplyEncoded = "%2e%2e";
    for (let depth = 0; depth < 10; depth += 1) deeplyEncoded = encodeURIComponent(deeplyEncoded);
    expect(() => client.get(`/${deeplyEncoded}/version`)).toThrow("dot segments");

    const malformed = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([new Response("not-json", { status: 200 })]).fetch,
    });
    await expect(malformed.get("/version")).rejects.toThrow("invalid JSON");

    const oversized = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      maxRetries: 0,
      maxResponseBytes: 4,
      fetch: mockFetch([new Response('{"ok":true}', { status: 200 })]).fetch,
    });
    await expect(oversized.get("/version")).rejects.toThrow("exceeds 4 bytes");

    const oversizedDeclared = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      maxRetries: 0,
      maxResponseBytes: 4,
      fetch: mockFetch([new Response("{}", { status: 200, headers: { "Content-Length": "5" } })])
        .fetch,
    });
    await expect(oversizedDeclared.get("/version")).rejects.toThrow("exceeds 4 bytes");

    const unreadableResponse = {
      status: 200,
      ok: true,
      headers: new Headers(),
      body: null,
      json: () => Promise.reject(new TypeError("stream disconnected")),
    } as unknown as Response;
    const unreadable = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      maxRetries: 0,
      fetch: mockFetch([unreadableResponse]).fetch,
    });
    await expect(unreadable.get("/version")).rejects.toMatchObject({
      status: 0,
      message: "GitLab API response body could not be read",
    });
  });

  test("accepts exact response limits and split UTF-8 streams", async () => {
    const exactDeclared = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      maxResponseBytes: 2,
      fetch: mockFetch([new Response("{}", { status: 200, headers: { "Content-Length": "2" } })])
        .fetch,
    });
    expect(await exactDeclared.get("/version")).toMatchObject({ data: {} });

    const bodylessResponse = {
      status: 200,
      ok: true,
      headers: new Headers(),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    } as unknown as Response;
    const bodyless = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([bodylessResponse]).fetch,
    });
    expect(await bodyless.get("/version")).toMatchObject({ data: { ok: true } });

    const encoded = new TextEncoder().encode('{"value":"é"}');
    const splitAt = encoded.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, splitAt));
        controller.enqueue(encoded.slice(splitAt));
        controller.close();
      },
    });
    const streamed = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      maxResponseBytes: encoded.byteLength,
      fetch: mockFetch([new Response(stream, { status: 200 })]).fetch,
    });
    expect(await streamed.get("/version")).toMatchObject({ data: { value: "é" } });

    const oversizedBodylessResponse = {
      status: 200,
      ok: true,
      headers: new Headers({ "Content-Length": "3" }),
      body: null,
      text: () => Promise.resolve("{}"),
    } as unknown as Response;
    const oversizedBodyless = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      maxResponseBytes: 2,
      fetch: mockFetch([oversizedBodylessResponse]).fetch,
    });
    await expect(oversizedBodyless.get("/version")).rejects.toMatchObject({
      name: "GitLabApiError",
      status: 200,
      message: "GitLab API response exceeds 2 bytes",
    });
  });

  test("distinguishes exact, lower-bound, and unavailable counts", async () => {
    const { fetch } = mockFetch([
      jsonResponse([{}], { headers: { "X-Total": "42" } }),
      jsonResponse([]),
      jsonResponse([{}]),
      jsonResponse({ message: "forbidden" }, { status: 403 }),
    ]);
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch,
      maxRetries: 0,
    });

    expect(await client.count("/projects/1/issues")).toEqual({ kind: "exact", value: 42 });
    expect(await client.count("/projects/1/releases")).toEqual({ kind: "exact", value: 0 });
    expect(await client.count("/projects/1/merge_requests")).toEqual({
      kind: "at-least",
      value: 1,
    });
    expect(await client.count("/projects/1/members")).toEqual({
      kind: "unavailable",
      reason: "forbidden",
    });
  });

  test("keeps authentication failures fatal and hidden resources unavailable", async () => {
    const { fetch } = mockFetch([
      jsonResponse({ message: "unauthorized" }, { status: 401 }),
      jsonResponse({ message: "not found" }, { status: 404 }),
      jsonResponse({ total: 12 }),
    ]);
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch,
      maxRetries: 0,
    });

    await expect(client.count("/projects/1/issues")).rejects.toMatchObject({ status: 401 });
    expect(await client.count("/projects/1/members")).toEqual({
      kind: "unavailable",
      reason: "not-found-or-hidden",
    });
    await expect(client.count("/projects/1/releases")).rejects.toThrow("not an array");
  });

  test("rejects totals that contradict the returned page", async () => {
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      fetch: mockFetch([jsonResponse([{}], { headers: { "X-Total": "0" } })]).fetch,
    });

    await expect(client.count("/projects/1/issues")).rejects.toThrow("inconsistent X-Total");
  });

  test("retains terminal throttling telemetry", async () => {
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      maxRetries: 0,
      fetch: mockFetch([
        jsonResponse(
          {},
          {
            status: 429,
            headers: {
              "RateLimit-Limit": "600",
              "RateLimit-Remaining": "0",
              "RateLimit-Reset": "1786219200",
              "Retry-After": "12",
            },
          },
        ),
      ]).fetch,
    });

    await expect(client.get("/projects")).rejects.toMatchObject({ status: 429 });
    expect(client.getRateLimit()).toEqual({
      limit: 600,
      remaining: 0,
      reset: "1786219200",
      retryAfterSeconds: 12,
    });
  });

  test("captures HTTP-date Retry-After telemetry", async () => {
    const retryAt = new Date(Date.now() + 12_000).toUTCString();
    const client = new GitLabClient({
      baseUrl: "https://gitlab.com",
      token: "token",
      maxRetries: 0,
      fetch: mockFetch([jsonResponse({}, { status: 429, headers: { "Retry-After": retryAt } })])
        .fetch,
    });

    await expect(client.get("/projects")).rejects.toMatchObject({ status: 429 });
    expect(client.getRateLimit().retryAfterSeconds).toBeGreaterThanOrEqual(10);
    expect(client.getRateLimit().retryAfterSeconds).toBeLessThanOrEqual(12);
  });
});
