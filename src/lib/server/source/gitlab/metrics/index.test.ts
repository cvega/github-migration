import { describe, expect, test } from "bun:test";
import { GITLAB_PROFILE_METRIC_KEYS } from "$lib/source/gitlab-metrics";
import { GITLAB_METRIC_COLLECTORS } from "./collectors.generated";
import { GITLAB_METRIC_COLLECTORS_IN_ORDER, orderGitLabCollectors } from "./index";

const collect = async () => {
  throw new Error("not called");
};

describe("GitLab metric collector discovery", () => {
  test("has one collector module per collector file", () => {
    const stems = [...new Bun.Glob("*.collector.ts").scanSync({ cwd: import.meta.dir })];
    expect(GITLAB_METRIC_COLLECTORS).toHaveLength(stems.length);
  });

  test("returns collectors in the registry's collection order", () => {
    expect(GITLAB_METRIC_COLLECTORS_IN_ORDER.map(({ key }) => key)).toEqual([
      ...GITLAB_PROFILE_METRIC_KEYS,
    ]);
  });

  test("reorders to the requested keys", () => {
    const modules = [
      { key: "b", collect },
      { key: "a", collect },
    ];
    expect(orderGitLabCollectors(["a", "b"], modules).map(({ key }) => key)).toEqual(["a", "b"]);
  });

  test.each([
    ["a missing collector", ["a", "b"], ["a"], "b (missing)"],
    ["an unregistered collector", ["a"], ["a", "c"], "c"],
    ["a duplicate collector", ["a"], ["a", "a"], "a"],
  ])("rejects %s", (_name, keys, collectors, problem) => {
    expect(() =>
      orderGitLabCollectors(
        keys,
        collectors.map((key) => ({ key, collect })),
      ),
    ).toThrow(problem);
  });
});
