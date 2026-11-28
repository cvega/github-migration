import { z } from "zod";
import descriptor from "$lib/source/gitlab-metrics/mirrors.metric";
import type { GitLabProjectMetrics, ProfileNumericObservation } from "$lib/source/types";
import {
  GitLabApiError,
  type GitLabClient,
  GitLabPaginationError,
  GitLabRequestBudgetError,
} from "../client";
import { budgetObservation, metric } from "./counts";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

type MirrorMetric = GitLabProjectMetrics["mirrors"];

const PUSH_SCOPE = "enabled push mirrors visible via the project endpoint";
const pullMirrorResponse = z.object({ enabled: z.boolean() });
const pushMirrorResponse = pullMirrorResponse.extend({ id: z.int().positive() });

function mirrorUnavailableReason(
  error: unknown,
  signal?: AbortSignal,
): Extract<MirrorMetric["pullMirror"], { kind: "unavailable" }>["reason"] {
  if (signal?.aborted || !(error instanceof GitLabApiError)) throw error;
  if (error instanceof GitLabRequestBudgetError) return "request-budget";
  if (error.status === 401 || error.status === 403) return "forbidden";
  if (error.status === 404) return "not-reported";
  if (error.status === 200) return "malformed";
  throw error;
}

async function collectPushMirrors(
  client: GitLabClient,
  projectPath: string,
  options: GitLabMetricOptions,
): Promise<Pick<MirrorMetric, "observation" | "hasDisabledPushMirrors">> {
  const ids = new Set<number>();
  let enabled = 0;
  let hasDisabled = false;
  let observation: ProfileNumericObservation;
  try {
    for await (const page of client.paginatePages<unknown>(
      `${projectPath}/remote_mirrors`,
      {},
      options,
    )) {
      for (const entry of page) {
        const mirror = pushMirrorResponse.safeParse(entry);
        if (!mirror.success || ids.has(mirror.data.id)) {
          throw new GitLabPaginationError("GitLab push mirror evidence was malformed");
        }
        ids.add(mirror.data.id);
        if (mirror.data.enabled) enabled += 1;
        else hasDisabled = true;
      }
    }
    observation = { kind: "exact", value: enabled, basis: "enumerated", scope: PUSH_SCOPE };
  } catch (error) {
    const reason = mirrorUnavailableReason(error, options.signal);
    if (reason === "request-budget") {
      observation = budgetObservation(PUSH_SCOPE, enabled);
    } else if (reason !== "malformed" && enabled > 0) {
      observation = {
        kind: "at-least",
        value: enabled,
        reason: "pagination-uncertain",
        scope: `${PUSH_SCOPE}; incomplete: ${reason}`,
      };
    } else {
      observation = { kind: "unavailable", reason, scope: PUSH_SCOPE };
    }
  }
  const malformed = observation.kind === "unavailable" && observation.reason === "malformed";
  return {
    observation,
    hasDisabledPushMirrors:
      observation.kind === "exact" || (hasDisabled && !malformed) ? hasDisabled : null,
  };
}

async function collectPullMirror(
  client: GitLabClient,
  projectPath: string,
  options: GitLabMetricOptions,
): Promise<MirrorMetric["pullMirror"]> {
  try {
    const { data } = await client.get<unknown>(`${projectPath}/mirror/pull`, {}, options);
    const mirror = pullMirrorResponse.safeParse(data);
    if (!mirror.success) return { kind: "unavailable", reason: "malformed" };
    return { kind: mirror.data.enabled ? "enabled" : "disabled" };
  } catch (error) {
    // This GET returns 400 for "The project is not mirrored" after authorizing the read.
    if (!options.signal?.aborted && error instanceof GitLabApiError && error.status === 400) {
      return { kind: "not-mirrored" };
    }
    return { kind: "unavailable", reason: mirrorUnavailableReason(error, options.signal) };
  }
}

export default defineGitLabCollector(descriptor, async (client, project, options = {}) => {
  const nowMs = options.nowMs ?? Date.now();
  const projectPath = `/projects/${encodeURIComponent(project.sourceId)}`;
  const { observation, hasDisabledPushMirrors } = await collectPushMirrors(
    client,
    projectPath,
    options,
  );
  const pullMirror = await collectPullMirror(client, projectPath, options);
  return {
    ...metric("project-mirrors", observation, nowMs),
    hasDisabledPushMirrors,
    pullMirror,
  } satisfies MirrorMetric;
});
