import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { uploadArchive } from "./upload";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}

let calls: FetchCall[];
const realFetch = globalThis.fetch;

function record(input: RequestInfo | URL, init?: RequestInit): FetchCall {
  return {
    url: String(input),
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    signal: init?.signal,
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe("archive upload", () => {
  test("uploads a small archive in one encoded request", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(record(input, init));
      return new Response(JSON.stringify({ uri: "gei://archive/123" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(
      await uploadArchive(
        new Uint8Array(512),
        "my archive.tar.gz",
        "org-db",
        "token",
        "https://uploads.example.com",
      ),
    ).toBe("gei://archive/123");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]?.url).toContain("my%20archive.tar.gz");
    expect(calls[0]?.headers.Authorization).toBe("Bearer token");
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("logs only the status of a rejected upload", async () => {
    const controller = new AbortController();
    const warn = spyOn(console, "warn").mockImplementation(() => {
      queueMicrotask(() => controller.abort());
    });
    globalThis.fetch = (async () =>
      new Response(
        "Authorization: Bearer inert-test-token https://fixture.invalid/archive?signature=inert",
        { status: 503 },
      )) as unknown as typeof fetch;
    await expect(
      uploadArchive(new Uint8Array(1), "archive", "org", "token", undefined, controller.signal),
    ).rejects.toThrow("Aborted");
    expect(warn.mock.calls[0]?.[1]).toBe("Upload failed (HTTP 503)");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Authorization|inert|signature/);
  });

  test("rejects an already-aborted upload before fetch", async () => {
    globalThis.fetch = (async () => {
      calls.push({ url: "unexpected", method: "GET", headers: {} });
      return new Response();
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadArchive(new Uint8Array(1), "a.tar.gz", "org", "token", undefined, controller.signal),
    ).rejects.toThrow("Aborted");
    expect(calls).toEqual([]);
  });

  test("uploads large archives through same-origin multipart continuations", async () => {
    const archive = new Uint8Array(101 * 1024 * 1024);
    const locations = ["/uploads/part-1", "/uploads/part-2", "/uploads/complete"];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(record(input, init));
      if (calls.length <= 3) {
        return new Response(null, {
          status: calls.length === 1 ? 201 : 200,
          headers: { location: locations[calls.length - 1]! },
        });
      }
      return new Response(JSON.stringify({ uri: "gei://multipart/done" }), { status: 200 });
    }) as typeof fetch;
    expect(
      await uploadArchive(archive, "big.tar.gz", "org", "token", "https://uploads.example.com"),
    ).toBe("gei://multipart/done");
    expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH", "PATCH", "PUT"]);
    expect(calls[1]?.url).toBe("https://uploads.example.com/uploads/part-1");
  });

  test("rejects cross-origin continuations before forwarding the token", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(record(input, init));
      return new Response(null, {
        status: 201,
        headers: { location: "https://attacker.example/collect" },
      });
    }) as typeof fetch;
    await expect(
      uploadArchive(
        new Uint8Array(101 * 1024 * 1024),
        "big.tar.gz",
        "org",
        "secret",
        "https://uploads.example.com",
      ),
    ).rejects.toThrow("changed origin");
    expect(calls).toHaveLength(1);
  });
});
