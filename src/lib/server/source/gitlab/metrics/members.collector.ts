import descriptor, {
  type GitLabMembershipScope,
  gitLabMembershipScopeSchema,
} from "$lib/source/gitlab-metrics/members.metric";
import type { ProfileNumericMetric, ProfileNumericObservation } from "$lib/source/types";
import {
  GitLabApiError,
  type GitLabClient,
  GitLabPaginationError,
  GitLabRequestBudgetError,
} from "../client";
import { budgetObservation, metric } from "./counts";
import {
  defineGitLabCollector,
  type GitLabMetricCollector,
  type GitLabMetricOptions,
} from "./types";

const SCOPE =
  "Membership counts are non-additive across scopes; mannequins are not target access grants";
type MembershipMetric = ProfileNumericMetric & { scopes: GitLabMembershipScope[] };

async function countMembers(
  client: GitLabClient,
  path: string,
  kind: GitLabMembershipScope["kind"],
  effective: boolean,
  options: GitLabMetricOptions,
): Promise<GitLabMembershipScope["direct"]> {
  const scope = `${effective ? "Effective" : "Direct"} visible ${kind} members${effective ? ", including inherited and shared access" : " only"}; hidden invited members may be omitted; not a total audience or target access grant count`;
  const endpointFamily = `${kind}-members${effective ? "-all" : ""}`;
  const ids = new Set<number>();
  let observation: ProfileNumericObservation;
  try {
    for await (const page of client.paginatePages<unknown>(
      path,
      {},
      {
        signal: options.signal,
        apiCallCeiling: options.apiCallCeiling,
      },
    )) {
      for (const member of page) {
        if (
          typeof member !== "object" ||
          member === null ||
          !("id" in member) ||
          typeof member.id !== "number" ||
          !Number.isSafeInteger(member.id) ||
          member.id <= 0 ||
          ids.has(member.id)
        ) {
          throw new GitLabPaginationError("GitLab member identity evidence is malformed");
        }
        ids.add(member.id);
      }
    }
    observation = { kind: "exact", value: ids.size, basis: "enumerated", scope };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof GitLabRequestBudgetError) {
      observation = budgetObservation(scope, ids.size);
    } else if (error instanceof GitLabPaginationError) {
      observation = { kind: "unavailable", reason: "malformed", scope };
    } else if (error instanceof GitLabApiError && [401, 403, 404].includes(error.status)) {
      const reason = error.status === 404 ? "not-reported" : "forbidden";
      observation =
        ids.size > 0
          ? {
              kind: "at-least",
              value: ids.size,
              reason: "pagination-uncertain",
              scope: `${scope}; incomplete: ${reason}`,
            }
          : { kind: "unavailable", reason, scope };
    } else {
      throw error;
    }
  }
  return {
    ...metric(endpointFamily, observation, options.nowMs ?? Date.now()),
    provider: "gitlab",
  };
}

async function collectScope(
  client: GitLabClient,
  kind: GitLabMembershipScope["kind"],
  path: string,
  id: string,
  options: GitLabMetricOptions,
): Promise<GitLabMembershipScope> {
  const endpoint = `/${kind}s/${encodeURIComponent(id)}/members`;
  const direct = await countMembers(client, endpoint, kind, false, options);
  const effective = await countMembers(client, `${endpoint}/all`, kind, true, options);
  return { kind, path, direct, effective };
}

export async function collectGitLabMembers(
  client: GitLabClient,
  project: Parameters<GitLabMetricCollector>[1],
  options: GitLabMetricOptions = {},
): Promise<MembershipMetric> {
  const segments = project.path.split("/");
  const admitted = options.namespace && project.path.startsWith(`${options.namespace}/`);
  const malformed = segments.some((segment) => !segment || segment === "." || segment === "..");
  const observation: ProfileNumericObservation = {
    kind: "unavailable",
    reason: malformed ? "malformed" : admitted ? "unsupported" : "not-reported",
    scope: SCOPE,
  };
  const result: MembershipMetric = {
    ...metric("scoped-members", observation, options.nowMs ?? Date.now()),
    scopes: [],
  };
  if (!admitted || malformed) return result;

  result.scopes.push(
    await collectScope(client, "project", project.path, project.sourceId, options),
  );
  // The immediate parent is within the admitted namespace; its effective list includes inherited access.
  const parent = segments.slice(0, -1).join("/");
  const key = `members:group:${parent}`;
  let read = options.shared?.get(key);
  if (!read) {
    read = collectScope(client, "group", parent, parent, options);
    options.shared?.set(key, read);
  }
  result.scopes.push(gitLabMembershipScopeSchema.parse(await read));
  if (
    result.scopes.every(({ direct, effective }) =>
      [direct, effective].every(
        ({ observation }) =>
          observation.kind === "unavailable" && observation.reason === "request-budget",
      ),
    )
  ) {
    result.observation = budgetObservation(SCOPE);
  }
  return result;
}

export default defineGitLabCollector(descriptor, collectGitLabMembers);
