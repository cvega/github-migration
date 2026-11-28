import type { ProfileNumericMetric } from "$lib/source/types";

/** A valid stored observation for this metric: exact, with its scope. */
export default {
  provider: "gitlab",
  endpointFamily: "repository-commit-sequence",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: {
    kind: "exact",
    value: 340,
    basis: "reported",
    scope: "fixture default-branch commits",
  },
} satisfies ProfileNumericMetric;
