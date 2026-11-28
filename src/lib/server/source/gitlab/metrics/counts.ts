import { parseProfileNumericMetric } from "$lib/source/observations";
import type { ProfileNumericMetric, ProfileNumericObservation } from "$lib/source/types";
import {
  GitLabApiError,
  type GitLabClient,
  type GitLabCountObservation,
  GitLabPaginationError,
  GitLabRequestBudgetError,
} from "../client";
import type { GitLabMetricOptions } from "./types";

function scopedCountObservation(
  count: GitLabCountObservation,
  scope: string,
): ProfileNumericObservation {
  if (count.kind === "at-least") {
    return { ...count, reason: "request-budget", scope };
  }
  return { ...count, scope };
}

/** Counts already read are a lower bound; with nothing read the metric is unavailable. */
export function budgetObservation(scope: string, itemsRead = 0): ProfileNumericObservation {
  return itemsRead > 0
    ? { kind: "at-least", value: itemsRead, reason: "request-budget", scope }
    : { kind: "unavailable", reason: "request-budget", scope };
}

export function unavailableObservation(
  error: unknown,
  scope: string,
): ProfileNumericObservation | null {
  if (!(error instanceof GitLabApiError)) return null;
  if (error instanceof GitLabPaginationError) {
    return { kind: "unavailable", reason: "malformed", scope };
  }
  if (error.status === 403) return { kind: "unavailable", reason: "forbidden", scope };
  if (error.status === 404) {
    return { kind: "unavailable", reason: "not-found-or-hidden", scope };
  }
  return null;
}

export function metric(
  endpointFamily: string,
  observation: ProfileNumericObservation,
  nowMs: number,
): ProfileNumericMetric {
  return parseProfileNumericMetric({
    provider: "gitlab",
    endpointFamily,
    collectedAt: new Date(nowMs).toISOString(),
    observation,
  });
}

export async function collectFirstPageCountMetric(
  client: GitLabClient,
  projectId: string,
  collection: string,
  endpointFamily: string,
  scope: string,
  query: Record<string, string>,
  options: GitLabMetricOptions,
): Promise<ProfileNumericMetric> {
  const nowMs = options.nowMs ?? Date.now();
  try {
    const count = await client.count(
      `/projects/${encodeURIComponent(projectId)}/${collection}`,
      query,
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    );
    return metric(endpointFamily, scopedCountObservation(count, scope), nowMs);
  } catch (error) {
    if (!(error instanceof GitLabRequestBudgetError)) throw error;
    return metric(endpointFamily, budgetObservation(scope), nowMs);
  }
}

export async function collectEnumeratedCountMetric(
  client: GitLabClient,
  projectId: string,
  collection: string,
  endpointFamily: string,
  scope: string,
  options: GitLabMetricOptions,
): Promise<ProfileNumericMetric> {
  let value = 0;
  try {
    for await (const page of client.paginatePages<unknown>(
      `/projects/${encodeURIComponent(projectId)}/${collection}`,
      {},
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    )) {
      value += page.length;
    }
    return metric(
      endpointFamily,
      { kind: "exact", value, basis: "enumerated", scope },
      options.nowMs ?? Date.now(),
    );
  } catch (error) {
    if (error instanceof GitLabRequestBudgetError) {
      return metric(endpointFamily, budgetObservation(scope, value), options.nowMs ?? Date.now());
    }
    const observation = unavailableObservation(error, scope);
    if (!observation) throw error;
    if (error instanceof GitLabPaginationError) {
      console.warn(`[gitlab] ${endpointFamily} count unavailable: ${error.message}`);
    }
    return metric(endpointFamily, observation, options.nowMs ?? Date.now());
  }
}
