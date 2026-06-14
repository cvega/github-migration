/**
 * Tests for archive upload (the path that produced the "413 Payload Too Large"
 * failures). `uploadArchive` is the only export, so single-part vs multipart
 * selection, URL building, and the retry/abort wrapper are exercised through
 * it with a mocked global `fetch`.
 *
 * Note: the retry backoff is 5s × attempt, so these tests only drive paths that
 * succeed on the first attempt or abort immediately — never a real retry delay.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { uploadArchive } from "./upload";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let calls: FetchCall[];
const realFetch = globalThis.fetch;

function record(input: RequestInfo | URL, init?: RequestInit): FetchCall {
  return {
    url: String(input),
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe("uploadArchive — single part", () => {
  test("POSTs to the archive endpoint with an encoded name and returns the uri", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(record(input, init));
      return new Response(JSON.stringify({ uri: "gei://archive/123" }), { status: 200 });
    }) as typeof fetch;

    const uri = await uploadArchive(
      new Blob([new Uint8Array(1024)]),
      "my archive.tar.gz",
      "org-db-1",
      "tok",
      "https://uploads.example.com",
    );

    expect(uri).toBe("gei://archive/123");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one recorded fetch call");
    expect(call.method).toBe("POST");
    // Name must be URL-encoded (space → %20).
    expect(call.url).toContain("my%20archive.tar.gz");
    expect(call.url).toContain("/organizations/org-db-1/gei/archive");
    expect(call.headers.Authorization).toBe("Bearer tok");
  });

  test("accepts a Uint8Array body", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ uri: "gei://u8" }), { status: 200 })) as typeof fetch;
    const uri = await uploadArchive(new Uint8Array(512), "a.tar.gz", "org", "tok");
    expect(uri).toBe("gei://u8");
  });

  test("rejects immediately when the signal is already aborted (no fetch)", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls.push({ url: "x", method: "x", headers: {} });
      return new Response("{}");
    }) as typeof fetch;
    const ac = new AbortController();
    ac.abort();

    await expect(
      uploadArchive(new Uint8Array(16), "a.tar.gz", "org", "tok", undefined, ac.signal),
    ).rejects.toThrow("Aborted");
    expect(calls).toHaveLength(0);
  });
});

describe("uploadArchive — multipart (> 100 MiB)", () => {
  test("runs the start → part(s) → complete sequence", async () => {
    // 101 MiB pushes past the 100 MiB multipart cutoff → 2 parts.
    const big = new Uint8Array(101 * 1024 * 1024);
    let step = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(record(input, init));
      step += 1;
      if (step === 1) {
        // Start → returns a Location for the first part.
        return new Response(null, {
          status: 201,
          headers: { location: "/uploads/next/1" },
        });
      }
      if (step === 2) {
        // First PATCH part → Location for next.
        return new Response(null, { status: 200, headers: { location: "/uploads/next/2" } });
      }
      if (step === 3) {
        // Second PATCH part → Location for completion.
        return new Response(null, { status: 200, headers: { location: "/uploads/complete" } });
      }
      // Final PUT complete.
      return new Response(JSON.stringify({ uri: "gei://multipart/done" }), { status: 200 });
    }) as typeof fetch;

    const uri = await uploadArchive(
      big,
      "big.tar.gz",
      "org-db",
      "tok",
      "https://uploads.example.com",
    );

    expect(uri).toBe("gei://multipart/done");
    // start (POST) + 2 parts (PATCH) + complete (PUT) = 4 calls.
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH", "PATCH", "PUT"]);
    // Relative Location headers are resolved against the uploads base URL.
    const startCall = calls[1];
    const completeCall = calls[3];
    if (!startCall || !completeCall) throw new Error("expected four recorded fetch calls");
    expect(startCall.url).toBe("https://uploads.example.com/uploads/next/1");
    expect(completeCall.url).toBe("https://uploads.example.com/uploads/complete");
  });
});
