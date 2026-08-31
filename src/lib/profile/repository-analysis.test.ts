import { describe, expect, test } from "bun:test";
import { interpretGitSizerMetrics, normalizeGitSizerMetrics } from "./repository-analysis";

describe("git-sizer metric interpretation", () => {
  test("returns warning and critical findings in concern order", () => {
    expect(
      interpretGitSizerMetrics({
        maxBlobSize: {
          description: "The size of the largest blob object",
          value: 120_000_000,
          unit: "B",
          prefixes: "binary",
          referenceValue: 10_000_000,
          levelOfConcern: 12,
          objectName: "abc",
          objectDescription: "refs/heads/main:video.bin",
        },
        maxCheckoutPathDepth: {
          description: "The maximum path depth in any checkout",
          value: 40,
          unit: "",
          prefixes: "metric",
          referenceValue: 10,
          levelOfConcern: 40,
        },
      }),
    ).toEqual([
      {
        metric: "maxCheckoutPathDepth",
        description: "The maximum path depth in any checkout",
        value: 40,
        unit: "",
        prefixes: "metric",
        referenceValue: 10,
        levelOfConcern: 40,
        severity: "critical",
        objectName: null,
        objectDescription: null,
      },
      {
        metric: "maxBlobSize",
        description: "The size of the largest blob object",
        value: 120_000_000,
        unit: "B",
        prefixes: "binary",
        referenceValue: 10_000_000,
        levelOfConcern: 12,
        severity: "warning",
        objectName: "abc",
        objectDescription: "refs/heads/main:video.bin",
      },
    ]);
  });

  test("ignores low-concern and malformed metrics", () => {
    const metrics = {
      uniqueCommitCount: {
        description: "The total number of distinct commit objects",
        value: 10,
        unit: "",
        prefixes: "metric",
        referenceValue: 500_000,
        levelOfConcern: 0.5,
      },
      malformed: { value: "large", levelOfConcern: 10 },
    };
    expect(interpretGitSizerMetrics(metrics)).toEqual([]);
    expect(normalizeGitSizerMetrics(metrics)).toEqual([
      {
        metric: "uniqueCommitCount",
        description: "The total number of distinct commit objects",
        value: 10,
        unit: "",
        prefixes: "metric",
        referenceValue: 500_000,
        levelOfConcern: 0.5,
        objectName: null,
        objectDescription: null,
      },
    ]);
    expect(interpretGitSizerMetrics(null)).toEqual([]);
  });
});
