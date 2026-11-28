import type { GitLabProjectMetrics } from "$lib/source/types";

export default {
  provider: "gitlab",
  endpointFamily: "project-container-registry",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: {
    kind: "exact",
    value: 0,
    basis: "enumerated",
    scope: "visible project container registry repositories; images require separate transfer",
  },
  tags: {
    kind: "exact",
    value: 0,
    basis: "reported",
    scope: "reported tags in visible project container registry repositories",
  },
} satisfies GitLabProjectMetrics["containerRegistry"];
