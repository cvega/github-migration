import { describe, expect, test } from "bun:test";
import { parseProfileNumericMetric } from "$lib/source/observations";

describe("profile numeric observations", () => {
  test("accepts exact, lower-bound, and unavailable metrics", () => {
    const common = {
      provider: "gitlab",
      endpointFamily: "merge-requests",
      collectedAt: "2026-08-17T12:00:00Z",
    } as const;

    for (const observation of [
      { kind: "exact", value: 12, basis: "reported", scope: "project:42" },
      { kind: "at-least", value: 100, reason: "item-cap", scope: "project:42" },
      { kind: "unavailable", reason: "forbidden", scope: "project:42" },
    ] as const) {
      expect(parseProfileNumericMetric({ ...common, observation }).observation).toEqual(
        observation,
      );
    }
  });

  test("rejects negative values, malformed timestamps, and unknown reasons", () => {
    const metric = {
      provider: "bitbucket-server",
      endpointFamily: "pull-requests",
      collectedAt: "2026-08-17T12:00:00Z",
      observation: { kind: "exact", value: 1, basis: "enumerated", scope: "repo:1" },
    };

    expect(() =>
      parseProfileNumericMetric({
        ...metric,
        observation: { ...metric.observation, value: -1 },
      }),
    ).toThrow();
    expect(() => parseProfileNumericMetric({ ...metric, collectedAt: "yesterday" })).toThrow();
    expect(() =>
      parseProfileNumericMetric({
        ...metric,
        observation: { kind: "unavailable", reason: "unknown", scope: "repo:1" },
      }),
    ).toThrow();
  });
});
