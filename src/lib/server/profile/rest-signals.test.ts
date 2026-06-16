/**
 * Tests for the per-repo REST signals gatherer. The `rest` client is faked, so
 * these exercise the webhook count, the code-scanning presence check, the direct
 * collaborator count, the tag-protection count, and their independent
 * degrade-to-default behavior, with no network.
 */
import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "$lib/server/core/github";
import { gatherRepoRestSignals } from "./rest-signals";
import type { DiscoveredRepo } from "./types";

function repo(over: Partial<DiscoveredRepo> = {}): DiscoveredRepo {
  return {
    name: "widget",
    nameWithOwner: "acme/widget",
    visibility: "PRIVATE",
    isArchived: false,
    isFork: false,
    isEmpty: false,
    diskUsageKb: 100,
    hasWiki: false,
    hasIssues: true,
    hasProjects: false,
    hasDiscussions: false,
    hasPages: false,
    defaultBranch: "main",
    pushedAt: null,
    updatedAt: null,
    ...over,
  };
}

/**
 * A `rest` double that routes each endpoint to a handler. A handler may return a
 * response object or throw (to simulate 404/403). Missing handlers throw 404.
 */
function mockRest(
  handlers: Record<
    string,
    () => { status?: number; headers?: Record<string, string>; data?: unknown }
  >,
) {
  const rest = {
    request: async (route: string) => {
      const h = handlers[route];
      if (!h) throw Object.assign(new Error("Not Found"), { status: 404 });
      const res = h();
      return { status: res.status ?? 200, headers: res.headers ?? {}, data: res.data ?? [] };
    },
  } as unknown as GitHubClient;
  return rest;
}

describe("gatherRepoRestSignals", () => {
  test("gathers all four signals together", async () => {
    const rest = mockRest({
      "GET /repos/{owner}/{repo}/hooks": () => ({
        headers: {
          link: '<https://api.github.com/x?per_page=1&page=3>; rel="last"',
        },
        data: [{}],
      }),
      "GET /repos/{owner}/{repo}/code-scanning/alerts": () => ({ data: [{ number: 1 }] }),
      "GET /repos/{owner}/{repo}/collaborators": () => ({
        headers: {
          link: '<https://api.github.com/x?affiliation=direct&page=4>; rel="last"',
        },
        data: [{}],
      }),
      "GET /repos/{owner}/{repo}/tags/protection": () => ({ data: [{ id: 1 }, { id: 2 }] }),
    });

    expect(await gatherRepoRestSignals(rest, repo())).toEqual({
      webhooksCount: 3,
      hasCodeScanningAlerts: true,
      collaboratorsCount: 4,
      tagProtectionCount: 2,
    });
  });

  test("no code-scanning alerts → false", async () => {
    const rest = mockRest({
      "GET /repos/{owner}/{repo}/hooks": () => ({ data: [{}] }), // 1 hook, no last link
      "GET /repos/{owner}/{repo}/code-scanning/alerts": () => ({ data: [] }),
    });

    expect(await gatherRepoRestSignals(rest, repo())).toEqual({
      webhooksCount: 1,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 0,
      tagProtectionCount: 0,
    });
  });

  test("a 404 (code scanning not enabled) degrades to false", async () => {
    // The hooks handler is present; code-scanning falls through to the default
    // 404 thrower — the expected response when code scanning isn't set up.
    const rest = mockRest({
      "GET /repos/{owner}/{repo}/hooks": () => ({ data: [{}] }),
    });

    expect(await gatherRepoRestSignals(rest, repo())).toEqual({
      webhooksCount: 1,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 0,
      tagProtectionCount: 0,
    });
  });

  test("each signal degrades independently (a 403 on one doesn't suppress the other)", async () => {
    const rest = mockRest({
      "GET /repos/{owner}/{repo}/hooks": () => {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      },
      "GET /repos/{owner}/{repo}/code-scanning/alerts": () => ({ data: [{ number: 1 }] }),
    });

    expect(await gatherRepoRestSignals(rest, repo())).toEqual({
      webhooksCount: 0, // 403 → 0
      hasCodeScanningAlerts: true, // still read
      collaboratorsCount: 0,
      tagProtectionCount: 0,
    });
  });

  test("a 403 on code scanning (GHAS off / no scope) degrades to false", async () => {
    const rest = mockRest({
      "GET /repos/{owner}/{repo}/hooks": () => ({ data: [{}] }),
      "GET /repos/{owner}/{repo}/code-scanning/alerts": () => {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      },
    });

    expect(await gatherRepoRestSignals(rest, repo())).toEqual({
      webhooksCount: 1,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 0,
      tagProtectionCount: 0,
    });
  });

  test("counts a single page of collaborators by length and reads tag protection", async () => {
    const rest = mockRest({
      "GET /repos/{owner}/{repo}/collaborators": () => ({ data: [{}, {}, {}] }), // 3, no last link
      "GET /repos/{owner}/{repo}/tags/protection": () => ({ data: [{ id: 1 }] }),
    });

    expect(await gatherRepoRestSignals(rest, repo())).toEqual({
      webhooksCount: 0,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 3,
      tagProtectionCount: 1,
    });
  });

  test("tag protection 404 (none, or expressed as rulesets) degrades to 0", async () => {
    const rest = mockRest({
      "GET /repos/{owner}/{repo}/collaborators": () => ({ data: [{}] }),
      // tags/protection falls through to the default 404 thrower.
    });

    const res = await gatherRepoRestSignals(rest, repo());
    expect(res.tagProtectionCount).toBe(0);
    expect(res.collaboratorsCount).toBe(1);
  });

  test("returns all defaults for a malformed nameWithOwner without any request", async () => {
    let called = false;
    const rest = {
      request: async () => {
        called = true;
        return { data: [] };
      },
    } as unknown as GitHubClient;

    expect(await gatherRepoRestSignals(rest, repo({ nameWithOwner: "no-slash" }))).toEqual({
      webhooksCount: 0,
      hasCodeScanningAlerts: false,
      collaboratorsCount: 0,
      tagProtectionCount: 0,
    });
    expect(called).toBe(false);
  });
});
