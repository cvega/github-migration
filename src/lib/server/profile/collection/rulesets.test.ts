import { expect, test } from "bun:test";
import { getOrgRulesetCount } from "./rulesets";

test.each([
  [{ data: [] }, 0],
  [{ data: [{}], headers: { link: '<https://example.invalid/?page=204>; rel="last"' } }, 204],
  [{ data: {}, headers: { link: '<https://example.invalid/?page=204>; rel="last"' } }, null],
  [{ data: [{}], headers: { link: '<https://example.invalid/?page=2>; rel="next"' } }, null],
] as const)("interprets ruleset pagination evidence %j", async (response, expected) => {
  const rest = {
    request: async (_route: string, options: { per_page: number }) => {
      expect(options.per_page).toBe(1);
      return response;
    },
  };
  expect(await getOrgRulesetCount(rest as never, "acme")).toBe(expected);
});

test("reports denied rulesets as unavailable", async () => {
  const rest = {
    request: async () => {
      throw new Error("denied");
    },
  };
  expect(await getOrgRulesetCount(rest as never, "acme")).toBeNull();
});
