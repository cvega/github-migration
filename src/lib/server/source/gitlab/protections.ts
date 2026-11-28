import { parseProfileNumericMetric } from "$lib/source/observations";
import type {
  OBSERVATION_UNAVAILABLE_REASONS,
  ProfileNumericMetric,
  ProfileNumericObservation,
  SourceProjectInventory,
} from "$lib/source/types";
import {
  GitLabApiError,
  type GitLabClient,
  GitLabPaginationError,
  GitLabRequestBudgetError,
} from "./client";

export const GITLAB_PROTECTED_BRANCHES_SCOPE =
  "branch protection rules configured on the project, each wildcard pattern counted once; excludes rules inherited from a group";
export const GITLAB_INHERITED_PROTECTED_BRANCHES_SCOPE =
  "branch protection rules the project inherits from its group, each counted once per project";
export const GITLAB_PROTECTED_TAGS_SCOPE =
  "tag protection rules configured on the project, each wildcard pattern counted once";

type UnavailableReason = (typeof OBSERVATION_UNAVAILABLE_REASONS)[number];

/** Structurally the profile run's shared metric options. */
export interface GitLabProtectionOptions {
  signal?: AbortSignal;
  nowMs?: number;
  apiCallCeiling?: number;
  /** Authorized profile namespace; group rules are read only when it is a top-level group. */
  namespace?: string;
  /** Per-run memo so each rule list is requested once however many metrics read it. */
  shared?: Map<string, Promise<unknown>>;
}

interface ProtectionRule {
  name: string;
  /** `undefined` when the instance does not report inheritance (Free tier, older GitLab). */
  inherited: boolean | undefined;
}

type RuleList =
  | { kind: "complete"; rules: ProtectionRule[] }
  | { kind: "partial"; rules: ProtectionRule[] }
  | { kind: "unavailable"; reason: UnavailableReason };

class MalformedRuleError extends Error {}

function parseRule(value: unknown): ProtectionRule {
  if (typeof value !== "object" || value === null) throw new MalformedRuleError();
  const { name, inherited } = value as { name?: unknown; inherited?: unknown };
  if (typeof name !== "string" || name === "") throw new MalformedRuleError();
  if (inherited !== undefined && typeof inherited !== "boolean") throw new MalformedRuleError();
  return { name, inherited };
}

/**
 * Enumerates a rule list on the shared budget. Access and tier failures become
 * unavailable observations so the profile continues; other errors propagate.
 */
async function readRules(
  client: GitLabClient,
  path: string,
  notFound: UnavailableReason,
  options: GitLabProtectionOptions,
): Promise<RuleList> {
  const rules: ProtectionRule[] = [];
  try {
    for await (const page of client.paginatePages<unknown>(
      path,
      {},
      { signal: options.signal, apiCallCeiling: options.apiCallCeiling },
    )) {
      rules.push(...page.map(parseRule));
    }
    return { kind: "complete", rules };
  } catch (error) {
    if (error instanceof GitLabRequestBudgetError) {
      return rules.length > 0
        ? { kind: "partial", rules }
        : { kind: "unavailable", reason: "request-budget" };
    }
    if (error instanceof MalformedRuleError || error instanceof GitLabPaginationError) {
      return { kind: "unavailable", reason: "malformed" };
    }
    if (error instanceof GitLabApiError) {
      if (error.status === 401 || error.status === 403) {
        return { kind: "unavailable", reason: "forbidden" };
      }
      if (error.status === 404) return { kind: "unavailable", reason: notFound };
    }
    throw error;
  }
}

function shared(
  options: GitLabProtectionOptions,
  key: string,
  read: () => Promise<RuleList>,
): Promise<RuleList> {
  if (!options.shared) return read();
  let pending = options.shared.get(key) as Promise<RuleList> | undefined;
  if (!pending) {
    pending = read();
    options.shared.set(key, pending);
  }
  return pending;
}

function projectBranchRules(
  client: GitLabClient,
  projectId: string,
  options: GitLabProtectionOptions,
): Promise<RuleList> {
  return shared(options, `project-protected-branches:${projectId}`, () =>
    readRules(
      client,
      `/projects/${encodeURIComponent(projectId)}/protected_branches`,
      "not-found-or-hidden",
      options,
    ),
  );
}

/**
 * Group rules exist only on top-level groups and need Premium or Ultimate. A
 * subgroup namespace never reads an ancestor outside its authorization, and a
 * 404 from a visible group means the endpoint is not offered on its tier.
 */
function groupBranchRules(
  client: GitLabClient,
  options: GitLabProtectionOptions,
): Promise<RuleList> {
  const namespace = options.namespace;
  if (!namespace || namespace.includes("/")) {
    return Promise.resolve({ kind: "unavailable", reason: "unsupported" });
  }
  return shared(options, `group-protected-branches:${namespace}`, () =>
    readRules(
      client,
      `/groups/${encodeURIComponent(namespace)}/protected_branches`,
      "not-reported",
      options,
    ),
  );
}

/** Unflagged project rules that match a group rule are the group's, not the project's. */
function isInherited(rule: ProtectionRule, groupNames: ReadonlySet<string>): boolean {
  return rule.inherited ?? groupNames.has(rule.name);
}

function groupNames(group: RuleList): Set<string> {
  return new Set(group.kind === "unavailable" ? [] : group.rules.map(({ name }) => name));
}

function countObservation(list: RuleList, count: number, scope: string): ProfileNumericObservation {
  if (list.kind === "complete") return { kind: "exact", value: count, basis: "enumerated", scope };
  if (list.kind === "unavailable") return { kind: "unavailable", reason: list.reason, scope };
  return count > 0
    ? { kind: "at-least", value: count, reason: "request-budget", scope }
    : { kind: "unavailable", reason: "request-budget", scope };
}

function metric(
  endpointFamily: string,
  observation: ProfileNumericObservation,
  options: GitLabProtectionOptions,
): ProfileNumericMetric {
  return parseProfileNumericMetric({
    provider: "gitlab",
    endpointFamily,
    collectedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    observation,
  });
}

export async function collectGitLabProtectedBranchMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabProtectionOptions = {},
): Promise<ProfileNumericMetric> {
  const [rules, group] = await Promise.all([
    projectBranchRules(client, project.sourceId, options),
    groupBranchRules(client, options),
  ]);
  const scope = GITLAB_PROTECTED_BRANCHES_SCOPE;
  const names = groupNames(group);
  if (rules.kind === "unavailable")
    return metric("project-protected-branches", countObservation(rules, 0, scope), options);
  const own = rules.rules.filter((rule) => !isInherited(rule, names));
  // A partly read group list cannot classify unflagged rules, so only flagged ones are certain.
  if (group.kind === "partial" && own.some((rule) => rule.inherited === undefined)) {
    const certain = own.filter((rule) => rule.inherited === false).length;
    return metric(
      "project-protected-branches",
      countObservation({ kind: "partial", rules: rules.rules }, certain, scope),
      options,
    );
  }
  return metric("project-protected-branches", countObservation(rules, own.length, scope), options);
}

/**
 * Group rules apply to every project in the group, so a complete group list is
 * authoritative; rules the project marks inherited are merged by name so none
 * is counted twice. Without the group list, the project's own inheritance flags
 * are used when the instance reports them.
 */
export async function collectGitLabInheritedProtectedBranchMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabProtectionOptions = {},
): Promise<ProfileNumericMetric> {
  const [rules, group] = await Promise.all([
    projectBranchRules(client, project.sourceId, options),
    groupBranchRules(client, options),
  ]);
  const scope = GITLAB_INHERITED_PROTECTED_BRANCHES_SCOPE;
  const names = groupNames(group);
  const inherited = new Set(names);
  if (rules.kind !== "unavailable") {
    for (const rule of rules.rules) if (isInherited(rule, names)) inherited.add(rule.name);
  }
  let observation: ProfileNumericObservation;
  if (group.kind !== "unavailable") {
    observation = countObservation(group, inherited.size, scope);
  } else if (rules.kind === "unavailable") {
    observation = { kind: "unavailable", reason: rules.reason, scope };
  } else if (rules.rules.some((rule) => rule.inherited !== undefined)) {
    observation = countObservation(rules, inherited.size, scope);
  } else if (rules.kind === "partial") {
    observation = { kind: "unavailable", reason: "request-budget", scope };
  } else {
    // Neither source reports inheritance, so zero would be a guess.
    observation = { kind: "unavailable", reason: group.reason, scope };
  }
  return metric("protected-branch-inheritance", observation, options);
}

export async function collectGitLabProtectedTagMetric(
  client: GitLabClient,
  project: Pick<SourceProjectInventory, "sourceId">,
  options: GitLabProtectionOptions = {},
): Promise<ProfileNumericMetric> {
  const rules = await readRules(
    client,
    `/projects/${encodeURIComponent(project.sourceId)}/protected_tags`,
    "not-found-or-hidden",
    options,
  );
  const count = rules.kind === "unavailable" ? 0 : rules.rules.length;
  return metric(
    "project-protected-tags",
    countObservation(rules, count, GITLAB_PROTECTED_TAGS_SCOPE),
    options,
  );
}
