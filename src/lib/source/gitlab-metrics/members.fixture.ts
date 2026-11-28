import type { ProfileNumericMetric } from "$lib/source/types";
import type { GitLabMembershipScope } from "./members.metric";

const count = (value: number, scope: string): GitLabMembershipScope["direct"] => ({
  provider: "gitlab",
  endpointFamily: "project-members",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: { kind: "exact", value, basis: "enumerated", scope },
});

export default {
  provider: "gitlab",
  endpointFamily: "scoped-members",
  collectedAt: "2026-08-10T12:00:00.000Z",
  observation: {
    kind: "unavailable",
    reason: "unsupported",
    scope:
      "Membership counts are non-additive across scopes; mannequins are not target access grants",
  },
  scopes: [
    {
      kind: "project",
      path: "platform/products/services/repository-with-a-long-name-for-membership-review",
      direct: count(2, "Direct visible project members"),
      effective: {
        ...count(3, "Effective visible project members; hidden invited members may be omitted"),
        endpointFamily: "project-members-all",
      },
    },
    {
      kind: "group",
      path: "platform/products/services",
      direct: {
        ...count(1, "Direct visible group members"),
        endpointFamily: "group-members",
        observation: {
          kind: "at-least",
          value: 1,
          reason: "request-budget",
          scope: "Direct visible group members; request budget exhausted",
        },
      },
      effective: {
        ...count(0, "Effective visible group members"),
        endpointFamily: "group-members-all",
        observation: {
          kind: "unavailable",
          reason: "forbidden",
          scope: "Effective visible group members; hidden invited members may be omitted",
        },
      },
    },
  ],
} satisfies ProfileNumericMetric & { scopes: GitLabMembershipScope[] };
