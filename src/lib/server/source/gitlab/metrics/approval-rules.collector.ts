import { z } from "zod";
import descriptor from "$lib/source/gitlab-metrics/approval-rules.metric";
import type {
  GitLabProjectMetrics,
  ProfileNumericObservation,
  SourceProjectInventory,
} from "$lib/source/types";
import {
  GitLabApiError,
  type GitLabClient,
  GitLabPaginationError,
  GitLabRequestBudgetError,
} from "../client";
import { budgetObservation, metric } from "./counts";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

const ENDPOINT = "project-approval-rules";
const SCOPE = "merge request approval rules visible via the project endpoint";
const ruleSchema = z.object({
  id: z.int().positive(),
  approvals_required: z.int().nonnegative(),
  applies_to_all_protected_branches: z.boolean().optional(),
  protected_branches: z.array(z.object({ id: z.int().positive() })).optional(),
});

export async function collectGitLabApprovalRuleMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<GitLabProjectMetrics["approvalRules"]> {
  const nowMs = options.nowMs ?? Date.now();
  const ids = new Set<number>();
  let requiresApprovals = false;
  let hasRequiredProtectedBranchRules: boolean | null = false;

  function result(observation: ProfileNumericObservation): GitLabProjectMetrics["approvalRules"] {
    const presence = (observed: boolean | null) =>
      observation.kind === "exact" || (observation.kind === "at-least" && observed === true)
        ? observed
        : null;
    return {
      ...metric(ENDPOINT, observation, nowMs),
      requiresApprovals: presence(requiresApprovals),
      hasRequiredProtectedBranchRules: presence(hasRequiredProtectedBranchRules),
    };
  }

  try {
    for await (const page of client.paginatePages<unknown>(
      `/projects/${encodeURIComponent(project.sourceId)}/approval_rules`,
      {},
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    )) {
      for (const entry of page) {
        const rule = ruleSchema.safeParse(entry);
        if (!rule.success || ids.has(rule.data.id)) {
          throw new GitLabPaginationError("GitLab approval rule evidence was malformed");
        }
        ids.add(rule.data.id);
        if (rule.data.approvals_required === 0) continue;
        requiresApprovals = true;
        const all = rule.data.applies_to_all_protected_branches;
        const branches = rule.data.protected_branches;
        if (all || branches?.length) {
          hasRequiredProtectedBranchRules = true;
        } else if (hasRequiredProtectedBranchRules !== true && (all === undefined || !branches)) {
          hasRequiredProtectedBranchRules = null;
        }
      }
    }
    return result({ kind: "exact", value: ids.size, basis: "enumerated", scope: SCOPE });
  } catch (error) {
    if (options.signal?.aborted || !(error instanceof GitLabApiError)) throw error;
    if (error instanceof GitLabRequestBudgetError) {
      return result(budgetObservation(SCOPE, ids.size));
    }
    if (error.status === 200) {
      return result({ kind: "unavailable", reason: "malformed", scope: SCOPE });
    }
    const reason =
      error.status === 401 || error.status === 403
        ? "forbidden"
        : error.status === 404
          ? "not-reported"
          : null;
    if (!reason) throw error;
    return result(
      ids.size > 0
        ? {
            kind: "at-least",
            value: ids.size,
            reason: "pagination-uncertain",
            scope: `${SCOPE}; incomplete: ${reason}`,
          }
        : { kind: "unavailable", reason, scope: SCOPE },
    );
  }
}

export default defineGitLabCollector(descriptor, collectGitLabApprovalRuleMetric);
