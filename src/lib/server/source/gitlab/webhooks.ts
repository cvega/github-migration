import {
  GITLAB_WEBHOOK_EVENT_CATEGORIES,
  type GitLabWebhookEventCategory,
} from "$lib/source/gitlab-webhooks";
import { parseProfileNumericMetric } from "$lib/source/observations";
import type {
  GitLabWebhookMetric,
  ProfileNumericObservation,
  SourceProjectInventory,
} from "$lib/source/types";
import {
  GitLabApiError,
  type GitLabClient,
  GitLabPaginationError,
  GitLabRequestBudgetError,
} from "./client";

interface WebhookOptions {
  signal?: AbortSignal;
  nowMs?: number;
  apiCallCeiling?: number;
  namespace?: string;
}

type UnavailableReason = Extract<ProfileNumericObservation, { kind: "unavailable" }>["reason"];
interface HookEvidence {
  count: number;
  events: Set<GitLabWebhookEventCategory>;
  reason?: UnavailableReason;
}

const PROJECT_SCOPE =
  "project-local webhooks visible to the caller; enabled event categories observed only";
const GROUP_SCOPE =
  "inherited group webhook dependencies per project within the selected namespace; ancestors outside the selected namespace are not inspected; enabled event categories observed only";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collectHooks(
  client: GitLabClient,
  path: string,
  options: WebhookOptions,
): Promise<HookEvidence> {
  const ids = new Set<number>();
  const events = new Set<GitLabWebhookEventCategory>();
  try {
    for await (const page of client.paginatePages<unknown>(
      path,
      {},
      {
        signal: options.signal,
        apiCallCeiling: options.apiCallCeiling,
      },
    )) {
      for (const hook of page) {
        if (
          !isRecord(hook) ||
          typeof hook.id !== "number" ||
          !Number.isSafeInteger(hook.id) ||
          hook.id <= 0 ||
          ids.has(hook.id)
        ) {
          throw new GitLabPaginationError("GitLab webhook identity evidence is malformed");
        }
        ids.add(hook.id);
        for (const category of GITLAB_WEBHOOK_EVENT_CATEGORIES) {
          const field = `${category.replaceAll("-", "_")}_events`;
          if (!(field in hook)) continue;
          const enabled = hook[field];
          if (typeof enabled !== "boolean") {
            throw new GitLabPaginationError("GitLab webhook event evidence is malformed");
          }
          if (enabled) events.add(category);
        }
      }
    }
    return { count: ids.size, events };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof GitLabRequestBudgetError) {
      return { count: ids.size, events, reason: "request-budget" };
    }
    if (error instanceof GitLabPaginationError) {
      // Contradictory pages or identities invalidate the count, not just its completeness.
      return { count: 0, events: new Set(), reason: "malformed" };
    }
    if (error instanceof GitLabApiError) {
      if (error.status === 401 || error.status === 403) {
        return { count: ids.size, events, reason: "forbidden" };
      }
      // A hidden or unlicensed endpoint is not evidence that no hooks exist.
      if (error.status === 404) return { count: ids.size, events, reason: "not-reported" };
    }
    throw error;
  }
}

function metric(
  endpointFamily: string,
  scope: string,
  evidence: HookEvidence,
  options: WebhookOptions,
): GitLabWebhookMetric {
  const observation: ProfileNumericObservation = evidence.reason
    ? evidence.count > 0
      ? {
          kind: "at-least",
          value: evidence.count,
          reason: evidence.reason === "request-budget" ? "request-budget" : "pagination-uncertain",
          scope: `${scope}; incomplete: ${evidence.reason}`,
        }
      : { kind: "unavailable", reason: evidence.reason, scope }
    : { kind: "exact", value: evidence.count, basis: "enumerated", scope };
  return {
    ...parseProfileNumericMetric({
      provider: "gitlab",
      endpointFamily,
      collectedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
      observation,
    }),
    eventCategories: GITLAB_WEBHOOK_EVENT_CATEGORIES.filter((category) =>
      evidence.events.has(category),
    ),
  };
}

export async function collectGitLabProjectWebhookMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: WebhookOptions = {},
): Promise<GitLabWebhookMetric> {
  const evidence = await collectHooks(
    client,
    `/projects/${encodeURIComponent(project.sourceId)}/hooks`,
    options,
  );
  return metric("project-hooks", PROJECT_SCOPE, evidence, options);
}

export async function collectGitLabGroupWebhookMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "path">,
  options: WebhookOptions = {},
): Promise<GitLabWebhookMetric> {
  const evidence: HookEvidence = { count: 0, events: new Set() };
  const namespace = options.namespace;
  if (!namespace || !project.path.startsWith(`${namespace}/`)) {
    return metric("group-hooks", GROUP_SCOPE, { ...evidence, reason: "not-reported" }, options);
  }
  const segments = project.path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return metric("group-hooks", GROUP_SCOPE, { ...evidence, reason: "malformed" }, options);
  }
  // Only inspect admitted ancestors, never the ancestors above the selected namespace.
  for (let depth = namespace.split("/").length; depth < segments.length; depth += 1) {
    const group = await collectHooks(
      client,
      `/groups/${encodeURIComponent(segments.slice(0, depth).join("/"))}/hooks`,
      options,
    );
    evidence.count += group.count;
    for (const category of group.events) evidence.events.add(category);
    evidence.reason ??= group.reason;
    if (group.reason === "request-budget") {
      evidence.reason = "request-budget";
      break;
    }
  }
  return metric("group-hooks", GROUP_SCOPE, evidence, options);
}
