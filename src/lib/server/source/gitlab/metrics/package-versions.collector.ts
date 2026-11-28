import { z } from "zod";
import descriptor, {
  gitLabPackageEcosystemSchema,
} from "$lib/source/gitlab-metrics/package-versions.metric";
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

const SCOPE =
  "visible package entries with status=default in this selected project only; no group-wide list; republish packages and reconfigure consumers separately";
const packageSchema = z.object({ id: z.int().positive(), package_type: z.string().trim().min(1) });

export async function collectGitLabPackageVersionMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabMetricOptions = {},
): Promise<GitLabProjectMetrics["packageVersions"]> {
  const ids = new Set<number>();
  const ecosystemCounts: NonNullable<GitLabProjectMetrics["packageVersions"]["ecosystemCounts"]> =
    {};
  const nowMs = options.nowMs ?? Date.now();
  function result(observation: ProfileNumericObservation): GitLabProjectMetrics["packageVersions"] {
    return {
      ...metric("project-packages", observation, nowMs),
      ecosystemCounts: observation.kind === "unavailable" ? null : ecosystemCounts,
    };
  }

  try {
    for await (const page of client.paginatePages<unknown>(
      `/projects/${encodeURIComponent(project.sourceId)}/packages`,
      { status: "default" },
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    )) {
      for (const entry of page) {
        const parsed = packageSchema.safeParse(entry);
        if (!parsed.success || ids.has(parsed.data.id)) {
          throw new GitLabPaginationError("GitLab package entry evidence was malformed");
        }
        ids.add(parsed.data.id);
        const ecosystem = gitLabPackageEcosystemSchema.safeParse(parsed.data.package_type);
        const key = ecosystem.success ? ecosystem.data : "other";
        ecosystemCounts[key] = (ecosystemCounts[key] ?? 0) + 1;
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

export default defineGitLabCollector(descriptor, collectGitLabPackageVersionMetric);
