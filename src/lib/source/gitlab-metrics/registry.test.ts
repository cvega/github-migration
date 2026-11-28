import { describe, expect, test } from "bun:test";
import { parseGitLabProfileEnrichment } from "../profile";
import { defineGitLabMetric } from "./define";
import { GITLAB_METRIC_FIXTURES } from "./fixtures.generated";
import {
  GITLAB_PROFILE_METRIC_CARDS,
  GITLAB_PROFILE_METRIC_KEYS,
  GITLAB_PROFILE_METRICS,
  GITLAB_PROTECTION_RULE_METRIC_KEYS,
  orderGitLabMetrics,
} from "./index";

function moduleStems(suffix: string): string[] {
  return [...new Bun.Glob(`*.${suffix}.ts`).scanSync({ cwd: import.meta.dir })]
    .map((path) => path.slice(0, -`.${suffix}.ts`.length))
    .sort();
}

const descriptor = (key: string, order: number, position: number) =>
  defineGitLabMetric({ key, order, card: { label: key, icon: "tag", position } });

describe("GitLab metric module discovery", () => {
  test("registers one metric per metric module and one fixture per metric", () => {
    expect(GITLAB_PROFILE_METRICS).toHaveLength(moduleStems("metric").length);
    expect(moduleStems("fixture")).toEqual(moduleStems("metric"));
    expect(Object.keys(GITLAB_METRIC_FIXTURES).sort()).toEqual(
      [...GITLAB_PROFILE_METRIC_KEYS].sort(),
    );
  });

  test("keeps collection order and card order independent of file names", () => {
    const orders: number[] = GITLAB_PROFILE_METRICS.map(({ order }) => order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(GITLAB_PROFILE_METRIC_CARDS.map(({ position }) => position)).toEqual(
      [...GITLAB_PROFILE_METRIC_CARDS.map(({ position }) => position)].sort((a, b) => a - b),
    );
  });

  test("derives the protection rule keys from their descriptors", () => {
    expect(GITLAB_PROTECTION_RULE_METRIC_KEYS).toEqual([
      "protectedBranches",
      "inheritedProtectedBranches",
      "protectedTags",
    ]);
  });

  test("stores every fixture through the enrichment schema", () => {
    const enrichment = {
      version: 2,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform",
      projects: [{ sourceId: "1", path: "platform/api", metrics: GITLAB_METRIC_FIXTURES }],
    };
    const parsed = parseGitLabProfileEnrichment(enrichment);
    expect(Object.keys(parsed.projects[0]?.metrics ?? {})).toEqual([...GITLAB_PROFILE_METRIC_KEYS]);
  });
});

describe("orderGitLabMetrics", () => {
  test("sorts by order", () => {
    expect(
      orderGitLabMetrics([descriptor("b", 1, 0), descriptor("a", 0, 1)]).map(({ key }) => key),
    ).toEqual(["a", "b"]);
  });

  test.each([
    ["key", [descriptor("a", 0, 0), descriptor("a", 1, 1)]],
    ["order", [descriptor("a", 0, 0), descriptor("b", 0, 1)]],
    ["card.position", [descriptor("a", 0, 0), descriptor("b", 1, 0)]],
  ])("rejects a duplicate %s", (field, descriptors) => {
    expect(() => orderGitLabMetrics(descriptors)).toThrow(`unique ${field}`);
  });
});
