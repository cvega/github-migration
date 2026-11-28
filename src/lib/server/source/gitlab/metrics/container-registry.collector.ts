import { z } from "zod";
import descriptor from "$lib/source/gitlab-metrics/container-registry.metric";
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

const REPOSITORY_SCOPE =
  "visible project container registry repositories; images require separate transfer";
const TAG_SCOPE = "reported tags in visible project container registry repositories";
const repositorySchema = z.object({ id: z.int().positive(), tags_count: z.unknown().optional() });
const tagCountSchema = z.int().nonnegative();

export async function collectGitLabContainerRegistryMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<GitLabProjectMetrics["containerRegistry"]> {
  const nowMs = options.nowMs ?? Date.now();
  const ids = new Set<number>();
  let tags = 0;
  let tagReports = 0;
  let missingTags = false;
  let malformedTags = false;

  function result(
    observation: ProfileNumericObservation,
  ): GitLabProjectMetrics["containerRegistry"] {
    let tagObservation: ProfileNumericObservation;
    if (observation.kind === "unavailable" && observation.reason === "malformed") {
      tagObservation = { ...observation, scope: TAG_SCOPE };
    } else if (malformedTags) {
      tagObservation = { kind: "unavailable", reason: "malformed", scope: TAG_SCOPE };
    } else if (observation.kind === "exact" && !missingTags) {
      tagObservation = { kind: "exact", value: tags, basis: "reported", scope: TAG_SCOPE };
    } else if (tagReports > 0) {
      tagObservation = {
        kind: "at-least",
        value: tags,
        reason: observation.kind === "at-least" ? observation.reason : "pagination-uncertain",
        scope: missingTags ? `${TAG_SCOPE}; some repositories omit tags_count` : TAG_SCOPE,
      };
    } else {
      tagObservation = {
        kind: "unavailable",
        reason:
          observation.kind === "unavailable"
            ? observation.reason
            : observation.kind === "at-least" && observation.reason === "request-budget"
              ? "request-budget"
              : "not-reported",
        scope: TAG_SCOPE,
      };
    }
    return { ...metric("project-container-registry", observation, nowMs), tags: tagObservation };
  }

  try {
    for await (const page of client.paginatePages<unknown>(
      `/projects/${encodeURIComponent(project.sourceId)}/registry/repositories`,
      { tags_count: "true" },
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    )) {
      for (const entry of page) {
        const repository = repositorySchema.safeParse(entry);
        if (!repository.success || ids.has(repository.data.id)) {
          throw new GitLabPaginationError("GitLab registry repository evidence was malformed");
        }
        ids.add(repository.data.id);
        if (repository.data.tags_count == null) {
          missingTags = true;
          continue;
        }
        const count = tagCountSchema.safeParse(repository.data.tags_count);
        if (!count.success || !Number.isSafeInteger(tags + count.data)) {
          malformedTags = true;
          continue;
        }
        tagReports++;
        tags += count.data;
      }
    }
    return result({ kind: "exact", value: ids.size, basis: "enumerated", scope: REPOSITORY_SCOPE });
  } catch (error) {
    if (options.signal?.aborted || !(error instanceof GitLabApiError)) throw error;
    if (error instanceof GitLabRequestBudgetError) {
      return result(budgetObservation(REPOSITORY_SCOPE, ids.size));
    }
    const reason =
      error.status === 200
        ? "malformed"
        : error.status === 401 || error.status === 403
          ? "forbidden"
          : error.status === 404
            ? "not-reported"
            : null;
    if (!reason) throw error;
    return result(
      ids.size > 0 && reason !== "malformed"
        ? {
            kind: "at-least",
            value: ids.size,
            reason: "pagination-uncertain",
            scope: `${REPOSITORY_SCOPE}; incomplete: ${reason}`,
          }
        : { kind: "unavailable", reason, scope: REPOSITORY_SCOPE },
    );
  }
}

export default defineGitLabCollector(descriptor, collectGitLabContainerRegistryMetric);
