import { z } from "zod";
import descriptor from "$lib/source/gitlab-metrics/deploy-keys.metric";
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

const ENDPOINT = "project-deploy-keys";
const SCOPE = "deploy keys visible via the project endpoint";
const deployKeySchema = z.object({ can_push: z.boolean() });

export async function collectGitLabDeployKeyMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<GitLabProjectMetrics["deployKeys"]> {
  const nowMs = options.nowMs ?? Date.now();
  let readOnlyCount = 0;
  let pushCapableCount = 0;

  function result(observation: ProfileNumericObservation): GitLabProjectMetrics["deployKeys"] {
    return {
      ...metric(ENDPOINT, observation, nowMs),
      readOnlyCount: observation.kind === "unavailable" ? null : readOnlyCount,
      pushCapableCount: observation.kind === "unavailable" ? null : pushCapableCount,
    };
  }

  try {
    for await (const page of client.paginatePages<unknown>(
      `/projects/${encodeURIComponent(project.sourceId)}/deploy_keys`,
      {},
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    )) {
      for (const entry of page) {
        const key = deployKeySchema.safeParse(entry);
        if (!key.success) throw new GitLabPaginationError("GitLab deploy key access was malformed");
        if (key.data.can_push) pushCapableCount += 1;
        else readOnlyCount += 1;
      }
    }
    return result({
      kind: "exact",
      value: readOnlyCount + pushCapableCount,
      basis: "enumerated",
      scope: SCOPE,
    });
  } catch (error) {
    if (options.signal?.aborted || !(error instanceof GitLabApiError)) throw error;
    const value = readOnlyCount + pushCapableCount;
    if (error instanceof GitLabRequestBudgetError) return result(budgetObservation(SCOPE, value));
    if (error.status === 200) {
      console.warn(`[gitlab] ${ENDPOINT} count unavailable: malformed provider response`);
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
      value > 0
        ? {
            kind: "at-least",
            value,
            reason: "pagination-uncertain",
            scope: `${SCOPE}; incomplete: ${reason}`,
          }
        : { kind: "unavailable", reason, scope: SCOPE },
    );
  }
}

export default defineGitLabCollector(descriptor, collectGitLabDeployKeyMetric);
