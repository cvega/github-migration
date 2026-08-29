import { expect, test } from "bun:test";
import { getOrgRulesetCount } from "./rulesets";

test("counts organization rulesets and degrades failures", async () => {
  expect(
    await getOrgRulesetCount({ request: async () => ({ data: [{}, {}] }) } as never, "acme"),
  ).toBe(2);
  expect(
    await getOrgRulesetCount(
      {
        request: async () => {
          throw new Error("denied");
        },
      } as never,
      "acme",
    ),
  ).toBe(0);
});
