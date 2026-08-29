import { afterEach, describe, expect, test } from "bun:test";
import { fetchGitHubStatus, getCachedGitHubStatus } from "./github-status";

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
const realWarn = console.warn;

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
  console.warn = realWarn;
});

describe("getCachedGitHubStatus", () => {
  test("returns an all-clear initial value without fetching", () => {
    expect(getCachedGitHubStatus()).toEqual({ ok: true, incidentCount: 0, incidents: [] });
  });

  test("fetches, maps, caches, and gracefully retains the last known status", async () => {
    let now = 1_000_000;
    let fetchCalls = 0;
    Date.now = () => now;
    console.warn = () => {};
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({
        incidents: [
          { name: "Actions disruption", status: "investigating", shortlink: "https://stspg.io/x" },
        ],
      });
    }) as unknown as typeof fetch;

    const incidentStatus = {
      ok: false,
      incidentCount: 1,
      incidents: [
        { name: "Actions disruption", status: "investigating", url: "https://stspg.io/x" },
      ],
    };
    expect(await fetchGitHubStatus()).toEqual(incidentStatus);
    expect(await fetchGitHubStatus()).toEqual(incidentStatus);
    expect(fetchCalls).toBe(1);
    expect(getCachedGitHubStatus()).toEqual(incidentStatus);

    now += 60_001;
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    expect(await fetchGitHubStatus()).toEqual(incidentStatus);

    now += 60_001;
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchGitHubStatus()).toEqual(incidentStatus);
  });
});
