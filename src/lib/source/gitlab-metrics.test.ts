import { describe, expect, test } from "bun:test";
import octicons from "@primer/octicons";
import { GITLAB_PROFILE_METRIC_CARDS, GITLAB_PROFILE_METRICS } from "./gitlab-metrics";
import { gitLabMetricFixtures } from "./gitlab-metrics/fixtures";
import { parseGitLabProfileEnrichment } from "./profile";

const metric = {
  provider: "gitlab",
  endpointFamily: "project-issues",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: { kind: "unavailable", reason: "request-budget", scope: "test scope" },
} as const;

describe("GitLab profile metric registry", () => {
  test("declares each metric once with a renderable card", () => {
    const keys = GITLAB_PROFILE_METRICS.map((descriptor) => descriptor.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "issues",
      "mergeRequests",
      "commits",
      "branches",
      "tags",
      "releases",
      "ciConfiguration",
      "protectedBranches",
      "inheritedProtectedBranches",
      "protectedTags",
      "projectWebhooks",
      "groupWebhooks",
      "ciVariables",
      "approvalRules",
      "members",
      "mirrors",
      "containerRegistry",
      "packageVersions",
    ]);
    for (const { card } of GITLAB_PROFILE_METRICS) {
      expect(card.label).not.toBe("");
      expect(Object.keys(octicons)).toContain(card.icon);
    }
    const positions = GITLAB_PROFILE_METRICS.map(({ card }) => card.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  test("renders the Repository contents cards in the established order", () => {
    expect(GITLAB_PROFILE_METRIC_CARDS.map(({ key, label }) => [key, label])).toEqual([
      ["commits", "Commits"],
      ["mergeRequests", "Merge requests"],
      ["branches", "Branches"],
      ["tags", "Tags"],
      ["releases", "Releases"],
      ["issues", "Visible issues"],
      ["ciConfiguration", "GitLab CI to convert"],
      ["protectedBranches", "Branch protection rules"],
      ["inheritedProtectedBranches", "Inherited branch rules"],
      ["protectedTags", "Tag protection rules"],
      ["projectWebhooks", "Project webhooks"],
      ["groupWebhooks", "Group hooks"],
      ["ciVariables", "Project CI/CD variables"],
      ["approvalRules", "Approval rules"],
      ["members", "Scoped membership"],
      ["mirrors", "Enabled push mirrors"],
      ["containerRegistry", "Container repositories"],
      ["packageVersions", "Package versions to republish"],
    ]);
    expect(GITLAB_PROFILE_METRIC_CARDS).toEqual(
      [...GITLAB_PROFILE_METRICS]
        .sort((left, right) => left.card.position - right.card.position)
        .map(({ key, card }) => ({ key, ...card })),
    );
  });

  test("keeps the stored enrichment schema in step with the registry keys", () => {
    const metrics = gitLabMetricFixtures();
    const enrichment = (projectMetrics: unknown) => ({
      version: 2,
      provider: "gitlab",
      sourceApiUrl: "https://gitlab.example.com/api/v4",
      namespace: "platform",
      projects: [{ sourceId: "1", path: "platform/api", metrics: projectMetrics }],
    });
    expect(() => parseGitLabProfileEnrichment(enrichment(metrics))).not.toThrow();
    const { issues: _issues, ...missing } = metrics;
    expect(() => parseGitLabProfileEnrichment(enrichment(missing))).toThrow();
    expect(() => parseGitLabProfileEnrichment(enrichment({ ...metrics, extra: metric }))).toThrow();
    expect(() =>
      parseGitLabProfileEnrichment(
        enrichment({
          ...metrics,
          projectWebhooks: { ...metric, eventCategories: ["destination"] },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseGitLabProfileEnrichment(
        enrichment({
          ...metrics,
          groupWebhooks: { ...metric, eventCategories: [], url: "discard-destination" },
        }),
      ),
    ).toThrow();
  });
});
