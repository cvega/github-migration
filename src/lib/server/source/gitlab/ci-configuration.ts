import { parseProfileNumericMetric } from "$lib/source/observations";
import type {
  ProfileNumericMetric,
  ProfileNumericObservation,
  SourceProjectInventory,
} from "$lib/source/types";
import { GitLabApiError, type GitLabClient, GitLabRequestBudgetError } from "./client";

const ENDPOINT_FAMILY = "project-ci-configuration";
const DEFAULT_CI_CONFIG_PATH = ".gitlab-ci.yml";
const NO_ACTIONS_WORKFLOW = "the importer generates no GitHub Actions workflow";

/**
 * Each classification is recorded as the observation scope. The value is 1 when
 * the project runs GitLab CI that needs conversion to Actions and 0 when it
 * does not; raw CI paths and file contents are never retained.
 */
export const GITLAB_CI_CONFIGURATION_SCOPES = {
  defaultFound: `default .gitlab-ci.yml found at HEAD; ${NO_ACTIONS_WORKFLOW}`,
  customFound: `custom CI file in this project found at HEAD; ${NO_ACTIONS_WORKFLOW}`,
  external: `CI configuration referenced from another project or external host; not fetched; ${NO_ACTIONS_WORKFLOW}`,
  autoDevOps: `Auto DevOps enabled without a local CI file; ${NO_ACTIONS_WORKFLOW}`,
  autoDevOpsUnreadFile: `Auto DevOps enabled; local CI file presence not read; ${NO_ACTIONS_WORKFLOW}`,
  absent: "no local CI file at HEAD and Auto DevOps disabled",
  disabled: "CI/CD disabled for the project",
  unknown: "project CI configuration; local CI file or Auto DevOps setting not determined",
} as const;

interface CiMetricOptions {
  signal?: AbortSignal;
  nowMs?: number;
  apiCallCeiling?: number;
}

type CiProject = Pick<SourceProjectInventory, "sourceId" | "defaultBranch" | "providerDetails">;

type LocalFile = "found" | "absent" | "forbidden" | "not-found-or-hidden" | "request-budget";

function metric(observation: ProfileNumericObservation, nowMs: number): ProfileNumericMetric {
  return parseProfileNumericMetric({
    provider: "gitlab",
    endpointFamily: ENDPOINT_FAMILY,
    collectedAt: new Date(nowMs).toISOString(),
    observation,
  });
}

function exact(value: 0 | 1, scope: string): ProfileNumericObservation {
  return { kind: "exact", value, basis: "reported", scope };
}

function unavailable(
  reason: Extract<ProfileNumericObservation, { kind: "unavailable" }>["reason"],
): ProfileNumericObservation {
  return { kind: "unavailable", reason, scope: GITLAB_CI_CONFIGURATION_SCOPES.unknown };
}

function accessObservation(error: unknown): ProfileNumericObservation | null {
  if (error instanceof GitLabRequestBudgetError) return unavailable("request-budget");
  if (!(error instanceof GitLabApiError)) return null;
  // Free tiers and limited roles answer with 401/403 for settings they don't expose.
  if (error.status === 401 || error.status === 403) return unavailable("forbidden");
  if (error.status === 404) return unavailable("not-found-or-hidden");
  return null;
}

/** GitLab's `path@namespace/project[:ref]` and URL forms point outside this project. */
function isExternalReference(path: string): boolean {
  return path.includes("@") || /^[a-z][a-z\d+.-]*:\/\//i.test(path);
}

function isSafeLocalPath(path: string): boolean {
  return (
    path.length <= 1_024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    ![...path].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function probeFailure(error: unknown): Exclude<LocalFile, "found" | "absent"> {
  if (error instanceof GitLabRequestBudgetError) return "request-budget";
  if (!(error instanceof GitLabApiError)) throw error;
  if (error.status === 404) return "not-found-or-hidden";
  if (error.status === 401 || error.status === 403) return "forbidden";
  throw error;
}

/**
 * A file 404 is also how GitLab answers when the repository is hidden from the
 * caller, so absence counts only after the default branch is confirmed readable.
 */
async function probeLocalFile(
  client: GitLabClient,
  projectId: string,
  path: string,
  defaultBranch: string,
  options: CiMetricOptions,
): Promise<LocalFile> {
  const requestOptions = { signal: options.signal, apiCallCeiling: options.apiCallCeiling };
  try {
    await client.head(
      `/projects/${projectId}/repository/files/${encodeURIComponent(path)}`,
      { ref: "HEAD" },
      requestOptions,
    );
    return "found";
  } catch (error) {
    const failure = probeFailure(error);
    if (failure !== "not-found-or-hidden") return failure;
  }
  try {
    await client.head(
      `/projects/${projectId}/repository/branches/${encodeURIComponent(defaultBranch)}`,
      {},
      requestOptions,
    );
    return "absent";
  } catch (error) {
    return probeFailure(error);
  }
}

/**
 * Detect CI configuration that needs conversion to GitHub Actions using only
 * same-project metadata: the project settings and a HEAD probe of the local
 * config file. Cross-project and external references are never requested.
 */
export async function collectGitLabCiConfigurationMetric(
  client: GitLabClient,
  project: CiProject,
  options: CiMetricOptions = {},
): Promise<ProfileNumericMetric> {
  const nowMs = options.nowMs ?? Date.now();
  const projectId = encodeURIComponent(project.sourceId);
  let settings: unknown;
  try {
    ({ data: settings } = await client.get<unknown>(
      `/projects/${projectId}`,
      {},
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    ));
  } catch (error) {
    const observation = accessObservation(error);
    if (!observation) throw error;
    return metric(observation, nowMs);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return metric(unavailable("malformed"), nowMs);
  }
  const fields = settings as Record<string, unknown>;

  if (fields.builds_access_level === "disabled") {
    return metric(exact(0, GITLAB_CI_CONFIGURATION_SCOPES.disabled), nowMs);
  }

  const configPath = fields.ci_config_path;
  if (configPath !== undefined && configPath !== null && typeof configPath !== "string") {
    return metric(unavailable("malformed"), nowMs);
  }
  // Only Maintainers and Owners see this field; absence is not "disabled".
  const autoDevOps =
    typeof fields.auto_devops_enabled === "boolean" ? fields.auto_devops_enabled : null;
  if (configPath === undefined) {
    return metric(
      autoDevOps === true
        ? exact(1, GITLAB_CI_CONFIGURATION_SCOPES.autoDevOpsUnreadFile)
        : unavailable("not-reported"),
      nowMs,
    );
  }

  const customPath = configPath?.trim() || null;
  if (customPath && isExternalReference(customPath)) {
    return metric(exact(1, GITLAB_CI_CONFIGURATION_SCOPES.external), nowMs);
  }
  if (customPath && !isSafeLocalPath(customPath)) {
    return metric(unavailable("malformed"), nowMs);
  }

  const emptyRepository =
    project.providerDetails?.provider === "gitlab" && project.providerDetails.emptyRepository;
  const localFile: LocalFile = emptyRepository
    ? "absent"
    : project.defaultBranch
      ? await probeLocalFile(
          client,
          projectId,
          customPath ?? DEFAULT_CI_CONFIG_PATH,
          project.defaultBranch,
          options,
        )
      : // Without a default branch on a non-empty repository, absence is unprovable.
        "not-found-or-hidden";

  if (localFile === "found") {
    return metric(
      exact(
        1,
        customPath
          ? GITLAB_CI_CONFIGURATION_SCOPES.customFound
          : GITLAB_CI_CONFIGURATION_SCOPES.defaultFound,
      ),
      nowMs,
    );
  }
  if (localFile === "absent") {
    if (autoDevOps === true)
      return metric(exact(1, GITLAB_CI_CONFIGURATION_SCOPES.autoDevOps), nowMs);
    if (autoDevOps === false) return metric(exact(0, GITLAB_CI_CONFIGURATION_SCOPES.absent), nowMs);
    return metric(unavailable("not-reported"), nowMs);
  }
  // The local file was not read, but enabled Auto DevOps still proves CI runs.
  if (autoDevOps === true) {
    return metric(
      localFile === "request-budget"
        ? {
            kind: "at-least",
            value: 1,
            reason: "request-budget",
            scope: GITLAB_CI_CONFIGURATION_SCOPES.autoDevOpsUnreadFile,
          }
        : exact(1, GITLAB_CI_CONFIGURATION_SCOPES.autoDevOpsUnreadFile),
      nowMs,
    );
  }
  return metric(unavailable(localFile), nowMs);
}
