import type { GitLabProjectMetrics } from "$lib/source/types";

/** A valid stored observation for this metric: exact, with project- and group-local scopes. */
export default {
  provider: "gitlab",
  endpointFamily: "ci-variables",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: {
    kind: "exact",
    value: 0,
    basis: "reported",
    scope: "fixture project-local CI/CD variable entries",
  },
  groupLocal: {
    kind: "exact",
    value: 0,
    basis: "reported",
    scope: "fixture group-local CI/CD variable entries",
  },
} satisfies GitLabProjectMetrics["ciVariables"];
