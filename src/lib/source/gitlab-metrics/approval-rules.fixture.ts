import type { GitLabProjectMetrics } from "$lib/source/types";

export default {
  provider: "gitlab",
  endpointFamily: "project-approval-rules",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: {
    kind: "exact",
    value: 0,
    basis: "enumerated",
    scope: "fixture project approval rules",
  },
  requiresApprovals: false,
  hasRequiredProtectedBranchRules: false,
} satisfies GitLabProjectMetrics["approvalRules"];
