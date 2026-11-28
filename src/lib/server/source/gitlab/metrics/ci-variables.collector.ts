import descriptor from "$lib/source/gitlab-metrics/ci-variables.metric";
import { parseProfileNumericMetric } from "$lib/source/observations";
import type {
  ProfileNumericMetric,
  ProfileNumericObservation,
  SourceProjectInventory,
} from "$lib/source/types";
import { GitLabApiError, type GitLabClient, GitLabRequestBudgetError } from "../client";
import { defineGitLabCollector, type GitLabMetricOptions } from "./types";

/**
 * Counts CI/CD variable entries without ever receiving a variable. GitLab's
 * list endpoints return names and values and have no field selection, so this
 * collector sends only `HEAD ...?per_page=1`: the response body is never read
 * and the count comes from the pagination headers. It must not call `get`,
 * `paginate` or `count` for these endpoints. A server that refuses `HEAD` leaves
 * the metric unavailable rather than falling back to the list. Nothing here
 * logs, and no name, value or environment scope reaches the stored metric.
 */
type Reason = Extract<ProfileNumericObservation, { kind: "unavailable" }>["reason"];
interface Evidence {
  value: number;
  /** Present when `value` is not a complete count. */
  reason?: Reason;
}

const PROJECT_SCOPE =
  "project-local CI/CD variable entries visible to the caller, counted from pagination headers; each environment-scoped entry counts once and names, values and scopes are never requested";
const GROUP_SCOPE =
  "group-local CI/CD variable entries on the project's ancestor groups within the selected namespace, counted per project from pagination headers; ancestors outside the selected namespace are not inspected and names, values and scopes are never requested";

function integer(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Reads a one-entry-per-page HEAD response; headers that disagree are malformed, not a count. */
function readCount(headers: Headers): Evidence {
  const malformed: Evidence = { value: 0, reason: "malformed" };
  const page = headers.get("x-page");
  const perPage = headers.get("x-per-page");
  if (
    (page !== null && integer(page) !== 1) ||
    (perPage !== null && integer(perPage) !== 1) ||
    headers.get("x-prev-page")
  ) {
    return malformed;
  }
  const next = headers.get("x-next-page");
  if (next && integer(next) !== 2) return malformed;

  const totalHeader = headers.get("x-total");
  if (totalHeader === null) {
    // Without a total only a next page proves more than one entry; otherwise 0 and 1 look alike.
    return next
      ? { value: 2, reason: "pagination-uncertain" as Reason }
      : { value: 0, reason: "not-reported" };
  }
  const total = integer(totalHeader);
  if (total === null) return malformed;
  const pagesHeader = headers.get("x-total-pages");
  const pages = integer(pagesHeader);
  if (pagesHeader !== null && (pages === null || (total <= 1 ? pages > 1 : pages !== total))) {
    return malformed;
  }
  // The next-page link must agree with the total.
  if ((total > 1 && next === "") || (total <= 1 && next)) return malformed;
  return { value: total };
}

async function countEntries(
  client: GitLabClient,
  path: string,
  options: GitLabMetricOptions,
): Promise<Evidence> {
  try {
    const { headers } = await client.head(
      path,
      { page: 1, per_page: 1 },
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    );
    return readCount(headers);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof GitLabRequestBudgetError) return { value: 0, reason: "request-budget" };
    if (error instanceof GitLabApiError) {
      if (error.status === 401 || error.status === 403) return { value: 0, reason: "forbidden" };
      // Hidden, or an endpoint this plan does not offer: not evidence that nothing is configured.
      if (error.status === 404) return { value: 0, reason: "not-reported" };
      // The server does not answer metadata requests here; never fall back to the value list.
      if (error.status === 405 || error.status === 501) return { value: 0, reason: "unsupported" };
    }
    throw error;
  }
}

function observe(scope: string, { value, reason }: Evidence): ProfileNumericObservation {
  if (!reason) return { kind: "exact", value, basis: "reported", scope };
  if (value === 0) return { kind: "unavailable", reason, scope };
  return {
    kind: "at-least",
    value,
    reason: reason === "request-budget" ? "request-budget" : "pagination-uncertain",
    scope: `${scope}; incomplete: ${reason}`,
  };
}

async function countGroups(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "path">,
  options: GitLabMetricOptions,
): Promise<Evidence> {
  const namespace = options.namespace;
  if (!namespace || !project.path.startsWith(`${namespace}/`)) {
    return { value: 0, reason: "not-reported" };
  }
  const segments = project.path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return { value: 0, reason: "malformed" };
  }
  const total: Evidence = { value: 0 };
  // Only inspect admitted ancestors, never the ancestors above the selected namespace.
  for (let depth = namespace.split("/").length; depth < segments.length; depth += 1) {
    const path = `/groups/${encodeURIComponent(segments.slice(0, depth).join("/"))}/variables`;
    const load = () => countEntries(client, path, options);
    let read: Promise<Evidence>;
    if (options.shared) {
      const key = `ci-variables:${path}`;
      read = (options.shared.get(key) as Promise<Evidence> | undefined) ?? load();
      options.shared.set(key, read);
    } else {
      read = load();
    }
    const group = await read;
    total.value += group.value;
    total.reason ??= group.reason;
    if (group.reason === "request-budget") {
      total.reason = "request-budget";
      break;
    }
  }
  return total;
}

export default defineGitLabCollector(descriptor, async (client, project, options = {}) => {
  // The project count completes before any group read so a spent budget degrades groups first.
  const local = await countEntries(
    client,
    `/projects/${encodeURIComponent(project.sourceId)}/variables`,
    options,
  );
  const groups = await countGroups(client, project, options);
  return {
    ...parseProfileNumericMetric({
      provider: "gitlab",
      endpointFamily: "ci-variables",
      collectedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
      observation: observe(PROJECT_SCOPE, local),
    }),
    groupLocal: observe(GROUP_SCOPE, groups),
  } as ProfileNumericMetric;
});
