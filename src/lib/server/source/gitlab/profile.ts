import { GITLAB_PROFILE_METRIC_KEYS } from "$lib/source/gitlab-metrics";
import { parseGitLabProfileEnrichment } from "$lib/source/profile";
import type {
  GitLabProfileEnrichment,
  GitLabProjectMetrics,
  SourceNamespaceInventory,
} from "$lib/source/types";
import { enrichmentWorkers } from "../enrichment-workers";
import type { GitLabClient } from "./client";
import { DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET } from "./config";
import { GITLAB_PROFILE_CONCURRENCY } from "./inventory";
import { GITLAB_METRIC_COLLECTORS_IN_ORDER } from "./metrics";
import type { GitLabMetricOptions } from "./metrics/types";
import { GitLabGroupHookCache } from "./webhooks";

interface GitLabProjectProfile {
  sourceId: string;
  path: string;
  metrics: GitLabProjectMetrics;
}

export async function collectGitLabProfileEnrichment(
  client: GitLabClient,
  inventory: SourceNamespaceInventory,
  options: {
    signal?: AbortSignal;
    nowMs?: number;
    concurrency?: number;
    /** Requests this collection may issue, retries and pagination included. */
    requestBudget?: number;
    /**
     * Absolute limit on the client's call counter shared with earlier phases of
     * the same profile run. Takes precedence over `requestBudget`.
     */
    apiCallCeiling?: number;
  } = {},
): Promise<GitLabProfileEnrichment> {
  if (inventory.provider !== "gitlab") {
    throw new TypeError("GitLab enrichment requires a GitLab inventory");
  }
  const concurrency = options.concurrency ?? GITLAB_PROFILE_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new TypeError("GitLab profile concurrency must be an integer between 1 and 16");
  }
  const requestBudget = options.requestBudget ?? DEFAULT_GITLAB_PROFILE_REQUEST_BUDGET;
  if (!Number.isSafeInteger(requestBudget) || requestBudget < 0) {
    throw new RangeError("GitLab profile request budget must be a non-negative integer");
  }
  if (
    options.apiCallCeiling !== undefined &&
    (!Number.isSafeInteger(options.apiCallCeiling) || options.apiCallCeiling < 0)
  ) {
    throw new RangeError("GitLab API call ceiling must be a non-negative integer");
  }

  const workers = enrichmentWorkers(options.signal);
  const metricOptions: GitLabMetricOptions = {
    signal: workers.signal,
    nowMs: options.nowMs,
    // The client counts every attempt synchronously before sending it, so this
    // one ceiling cannot be overshot by concurrent workers or retries.
    apiCallCeiling: options.apiCallCeiling ?? client.getApiCalls() + requestBudget,
    namespace: inventory.namespace,
    shared: new Map(),
    groupHookCache: new GitLabGroupHookCache(),
  };
  const projects = new Array<GitLabProjectProfile>(inventory.projects.length);
  let nextProject = 0;
  const worker = async (): Promise<void> => {
    while (nextProject < inventory.projects.length) {
      workers.signal.throwIfAborted();
      const position = nextProject++;
      const project = inventory.projects[position];
      if (!project) return;
      const collected = await workers.join(
        GITLAB_METRIC_COLLECTORS_IN_ORDER.map(({ collect }) =>
          collect(client, project, metricOptions),
        ),
      );
      projects[position] = {
        sourceId: project.sourceId,
        path: project.path,
        metrics: Object.fromEntries(
          GITLAB_PROFILE_METRIC_KEYS.map((key, index) => [key, collected[index]]),
        ) as GitLabProjectMetrics,
      };
    }
  };
  await workers.join(
    Array.from({ length: Math.min(concurrency, inventory.projects.length) }, () => worker()),
  );

  return parseGitLabProfileEnrichment({
    version: 2,
    provider: "gitlab",
    sourceApiUrl: inventory.sourceApiUrl,
    namespace: inventory.namespace,
    projects,
  });
}
