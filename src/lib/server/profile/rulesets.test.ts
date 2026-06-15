/**
 * Tests for org-ruleset gathering. The REST client is injected (a minimal
 * `request` double), so these exercise the count + the best-effort error
 * handling without a network.
 */
import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "$lib/server/core/github";
import { getOrgRulesetCount } from "./rulesets";

/** A REST client double whose `request` returns `data` or throws. */
function restWith(data: unknown, throws = false): GitHubClient {
  return {
    request: async () => {
      if (throws) throw new Error("403 Forbidden");
      return { data };
    },
  } as unknown as GitHubClient;
}

describe("getOrgRulesetCount", () => {
  test("counts the rulesets returned by the API", async () => {
    const rest = restWith([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(await getOrgRulesetCount(rest, "acme")).toBe(3);
  });

  test("returns 0 when the org has no rulesets", async () => {
    expect(await getOrgRulesetCount(restWith([]), "acme")).toBe(0);
  });

  test("degrades to 0 on an API error (missing scope, old GHES, network)", async () => {
    expect(await getOrgRulesetCount(restWith(null, true), "acme")).toBe(0);
  });

  test("degrades to 0 when the response is not an array", async () => {
    expect(await getOrgRulesetCount(restWith({ message: "weird" }), "acme")).toBe(0);
  });
});
