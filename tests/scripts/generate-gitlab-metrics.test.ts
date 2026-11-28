import { describe, expect, test } from "bun:test";
import { generateGitLabMetricModules } from "../../scripts/packaging/generate-gitlab-metrics";

describe("GitLab metric module generation", () => {
  test("lists each metric once in every generated file, in stem order", () => {
    const outputs = Object.values(
      generateGitLabMetricModules({
        metrics: ["alpha-beta", "gamma"],
        fixtures: ["alpha-beta", "gamma"],
        collectors: ["alpha-beta", "gamma"],
      }),
    );
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(output).toContain("Do not edit.");
      expect(output.indexOf("alphaBeta")).toBeLessThan(output.indexOf("gamma"));
    }
  });

  test("rejects a metric without its fixture or collector, and extras", () => {
    expect(() =>
      generateGitLabMetricModules({ metrics: ["a", "b"], fixtures: ["a", "c"], collectors: ["a"] }),
    ).toThrow(
      /b: missing fixture[\s\S]*c: fixture has no metric module[\s\S]*b: missing collector/,
    );
  });
});
