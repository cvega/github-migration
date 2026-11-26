#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { GitLabClient } from "$lib/server/source/gitlab/client";
import { gitlabComposeFile, verifyGitLabContract } from "../../tests/providers/gitlab/live";
import {
  CommandError,
  type CommandOutput,
  createComposeRuntime,
  createJsonStateFile,
  printOutput,
  redactSecrets,
  runProviderCommand,
  waitForContainerReady,
} from "./harness";

const ROOT = resolve(import.meta.dir, "../..");
const STATE_DIR = resolve(ROOT, ".provider-state");
const STATE_FILE = resolve(STATE_DIR, "gitlab.json");
const BASE_URL = "http://127.0.0.1:8929";
const API_URL = `${BASE_URL}/api/v4`;
const NAMESPACE = "provider-contract/nested";
const PAGINATED_NAMESPACE = "provider-contract/paginated";
const PAGINATED_PROJECT_COUNT = 101;
const ROOT_PASSWORD = `provider-test-${randomBytes(24).toString("hex")}`;

interface ProviderState {
  token: string;
  seededAt: string;
}

const stateFile = createJsonStateFile<ProviderState>(
  STATE_FILE,
  "GitLab provider state is missing; run the seed command first",
);

interface GitLabGroup {
  id: number;
  full_path: string;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
}

interface GitLabIssue {
  id: number;
  title: string;
}

interface GitLabBranch {
  name: string;
}

interface GitLabTag {
  name: string;
}

interface GitLabRelease {
  tag_name: string;
}

interface GitLabMergeRequest {
  id: number;
  source_branch: string;
  target_branch: string;
}

function redact(value: string, secrets: string[] = []): string {
  return redactSecrets(value, [ROOT_PASSWORD, ...secrets], [/glpat-[A-Za-z0-9_-]+/g]);
}

const composeEnvironment = () => ({
  ...process.env,
  COMPOSE_PROJECT_NAME: "github-migration-gitlab-provider",
  GITLAB_PROVIDER_ROOT_PASSWORD: ROOT_PASSWORD,
});

const composeRuntime = createComposeRuntime({
  root: ROOT,
  composeFile: gitlabComposeFile,
  detectionEnvironment: composeEnvironment,
});

async function compose(arguments_: string[]) {
  return composeRuntime.run(arguments_);
}

function printCommandOutput(output: CommandOutput, secrets: string[] = []) {
  printOutput(output, (value) => redact(value, secrets));
}

async function waitForReady(): Promise<void> {
  await waitForContainerReady({
    engine: composeRuntime.engine(),
    composeProject: "github-migration-gitlab-provider",
    composeService: "gitlab",
    providerName: "GitLab",
    baseUrl: BASE_URL,
  });
}

async function up(): Promise<void> {
  printCommandOutput(await compose(["up", "--detach", "gitlab"]));
  await waitForReady();
}

async function createToken(): Promise<string> {
  const ruby = [
    'name = "provider-contract"',
    'user = User.find_by_username!("root")',
    "user.personal_access_tokens.where(name: name).delete_all",
    'raw_token = "#{PersonalAccessToken.token_prefix}#{SecureRandom.hex(20)}"',
    "token = user.personal_access_tokens.create!(name: name, scopes: [:api], expires_at: 30.days.from_now.to_date)",
    "token.set_token(raw_token)",
    "token.save!",
    'puts "PROVIDER_TOKEN=#{raw_token}"',
  ].join("; ");
  const output = await compose(["exec", "-T", "gitlab", "gitlab-rails", "runner", ruby]);
  const token = output.stdout.match(/PROVIDER_TOKEN=(glpat-[A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error(`GitLab did not return a provider token: ${redact(output.stderr)}`);
  const user = await apiRequest<{ username?: unknown }>(token, "/user");
  if (user?.username !== "root") throw new Error("GitLab provider token authentication failed");
  return token;
}

async function apiRequest<T>(
  token: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown>; allowNotFound?: boolean } = {},
): Promise<T | null> {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "PRIVATE-TOKEN": token,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (options.allowNotFound && response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitLab API ${options.method ?? "GET"} ${path} failed: HTTP ${response.status} ${redact(text, [token]).slice(0, 2_000)}`,
    );
  }
  return text ? (JSON.parse(text) as T) : null;
}

async function ensureGroup(
  token: string,
  name: string,
  path: string,
  parent?: GitLabGroup,
): Promise<GitLabGroup> {
  const fullPath = parent ? `${parent.full_path}/${path}` : path;
  const existing = await apiRequest<GitLabGroup>(
    token,
    `/groups/${encodeURIComponent(fullPath)}?with_projects=false`,
    { allowNotFound: true },
  );
  if (existing) return existing;
  const created = await apiRequest<GitLabGroup>(token, "/groups", {
    method: "POST",
    body: {
      name,
      path,
      visibility: "private",
      ...(parent ? { parent_id: parent.id } : {}),
    },
  });
  if (!created) throw new Error(`GitLab did not return group ${fullPath}`);
  return created;
}

async function ensureProject(
  token: string,
  namespace: GitLabGroup,
  name: string,
  path: string,
  initializeWithReadme = true,
): Promise<GitLabProject> {
  const fullPath = `${namespace.full_path}/${path}`;
  const existing = await apiRequest<GitLabProject>(
    token,
    `/projects/${encodeURIComponent(fullPath)}`,
    { allowNotFound: true },
  );
  if (existing) return existing;
  const created = await apiRequest<GitLabProject>(token, "/projects", {
    method: "POST",
    body: {
      name,
      path,
      namespace_id: namespace.id,
      description: "Deterministic GitLab provider contract fixture",
      ...(initializeWithReadme ? { initialize_with_readme: true, default_branch: "main" } : {}),
      topics: ["provider-contract"],
      visibility: "private",
    },
  });
  if (!created) throw new Error(`GitLab did not return project ${fullPath}`);
  return created;
}

async function ensureIssue(token: string, project: GitLabProject, title: string): Promise<void> {
  const issues = await apiRequest<GitLabIssue[]>(
    token,
    `/projects/${project.id}/issues?scope=all&state=all&per_page=100`,
  );
  if (issues?.some((issue) => issue.title === title)) return;
  const created = await apiRequest<GitLabIssue>(token, `/projects/${project.id}/issues`, {
    method: "POST",
    body: { title, description: "Deterministic GitLab profile metric fixture" },
  });
  if (!created)
    throw new Error(`GitLab did not return issue fixture for ${project.path_with_namespace}`);
}

async function ensureFile(
  token: string,
  project: GitLabProject,
  branch: string,
  filePath: string,
  content: string,
): Promise<void> {
  const encodedPath = encodeURIComponent(filePath);
  const existing = await apiRequest<Record<string, unknown>>(
    token,
    `/projects/${project.id}/repository/files/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    { allowNotFound: true },
  );
  if (existing) return;
  const created = await apiRequest<Record<string, unknown>>(
    token,
    `/projects/${project.id}/repository/files/${encodedPath}`,
    {
      method: "POST",
      body: {
        branch,
        content,
        commit_message: `Add ${filePath}`,
      },
    },
  );
  if (!created)
    throw new Error(`GitLab did not create ${filePath} in ${project.path_with_namespace}`);
}

async function ensureBranch(
  token: string,
  project: GitLabProject,
  branch: string,
  ref: string,
): Promise<void> {
  const existing = await apiRequest<GitLabBranch>(
    token,
    `/projects/${project.id}/repository/branches/${encodeURIComponent(branch)}`,
    { allowNotFound: true },
  );
  if (existing) return;
  const created = await apiRequest<GitLabBranch>(
    token,
    `/projects/${project.id}/repository/branches`,
    { method: "POST", body: { branch, ref } },
  );
  if (created?.name !== branch) {
    throw new Error(`GitLab did not create branch ${branch} in ${project.path_with_namespace}`);
  }
}

async function ensureTag(
  token: string,
  project: GitLabProject,
  tagName: string,
  ref: string,
): Promise<void> {
  const existing = await apiRequest<GitLabTag>(
    token,
    `/projects/${project.id}/repository/tags/${encodeURIComponent(tagName)}`,
    { allowNotFound: true },
  );
  if (existing) return;
  const created = await apiRequest<GitLabTag>(token, `/projects/${project.id}/repository/tags`, {
    method: "POST",
    body: { tag_name: tagName, ref, message: "Provider contract release tag" },
  });
  if (created?.name !== tagName) {
    throw new Error(`GitLab did not create tag ${tagName} in ${project.path_with_namespace}`);
  }
}

async function ensureRelease(
  token: string,
  project: GitLabProject,
  tagName: string,
): Promise<void> {
  const existing = await apiRequest<GitLabRelease>(
    token,
    `/projects/${project.id}/releases/${encodeURIComponent(tagName)}`,
    { allowNotFound: true },
  );
  if (existing) return;
  const created = await apiRequest<GitLabRelease>(token, `/projects/${project.id}/releases`, {
    method: "POST",
    body: {
      tag_name: tagName,
      name: "Provider Contract v1.0.0",
      description: "Deterministic GitLab release fixture",
    },
  });
  if (created?.tag_name !== tagName) {
    throw new Error(`GitLab did not create release ${tagName} in ${project.path_with_namespace}`);
  }
}

async function ensureMergeRequest(
  token: string,
  project: GitLabProject,
  sourceBranch: string,
  targetBranch: string,
): Promise<void> {
  const existing = await apiRequest<GitLabMergeRequest[]>(
    token,
    `/projects/${project.id}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(sourceBranch)}&target_branch=${encodeURIComponent(targetBranch)}&per_page=100`,
  );
  if (
    existing?.some(
      (mergeRequest) =>
        mergeRequest.source_branch === sourceBranch && mergeRequest.target_branch === targetBranch,
    )
  ) {
    return;
  }
  const created = await apiRequest<GitLabMergeRequest>(
    token,
    `/projects/${project.id}/merge_requests`,
    {
      method: "POST",
      body: {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title: "Add profile metrics endpoint",
        description: "Deterministic GitLab merge request fixture",
        remove_source_branch: false,
      },
    },
  );
  if (!created) {
    throw new Error(`GitLab did not create merge request in ${project.path_with_namespace}`);
  }
}

async function seedRichProject(token: string, project: GitLabProject): Promise<void> {
  await ensureFile(token, project, "main", "src/app.ts", 'export const provider = "gitlab";\n');
  await ensureFile(
    token,
    project,
    "main",
    "docs/runbook.md",
    "# Service runbook\n\nDeterministic migration fixture.\n",
  );
  await ensureBranch(token, project, "feature/metrics", "main");
  await ensureFile(
    token,
    project,
    "feature/metrics",
    "src/metrics.ts",
    "export const metricCount = 1;\n",
  );
  await ensureTag(token, project, "v1.0.0", "main");
  await ensureRelease(token, project, "v1.0.0");
  await ensureMergeRequest(token, project, "feature/metrics", "main");
}

async function seed(): Promise<void> {
  const token = await createToken();
  const root = await ensureGroup(token, "Provider Contract", "provider-contract");
  const nested = await ensureGroup(token, "Nested", "nested", root);
  const platform = await ensureGroup(token, "Platform", "platform", nested);
  const serviceApi = await ensureProject(token, nested, "Service API", "service-api");
  const webClient = await ensureProject(token, nested, "Web Client", "web-client");
  await ensureProject(token, platform, "Worker", "worker");
  await seedRichProject(token, serviceApi);
  await ensureIssue(token, serviceApi, "Provider contract migration issue");
  await ensureIssue(token, webClient, "Provider contract accessibility issue");
  await ensureIssue(token, webClient, "Provider contract performance issue");
  const paginated = await ensureGroup(token, "Paginated", "paginated", root);
  for (let start = 1; start <= PAGINATED_PROJECT_COUNT; start += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, PAGINATED_PROJECT_COUNT - start + 1) }, (_, offset) => {
        const number = String(start + offset).padStart(3, "0");
        return ensureProject(
          token,
          paginated,
          `Pagination Project ${number}`,
          `project-${number}`,
          false,
        );
      }),
    );
  }
  await stateFile.write({ token, seededAt: new Date().toISOString() });
  console.log(
    `Seeded GitLab fixtures with repository history, branches, tags, releases, merge requests, 3 issues, and ${PAGINATED_PROJECT_COUNT} pagination projects`,
  );
}

async function testContract(): Promise<void> {
  const { token } = await stateFile.read();
  const client = new GitLabClient({ baseUrl: BASE_URL, token, allowInsecureHttp: true });
  await verifyGitLabContract(client, NAMESPACE, PAGINATED_NAMESPACE, PAGINATED_PROJECT_COUNT);
  console.log("GitLab live inventory, profile, pagination and export contracts passed");
}

async function diagnostics(): Promise<void> {
  let token = "";
  try {
    token = (await stateFile.read()).token;
  } catch {}
  for (const arguments_ of [["ps"], ["logs", "--tail", "300", "gitlab"]]) {
    try {
      printCommandOutput(await compose(arguments_), [token]);
    } catch (error) {
      if (error instanceof CommandError) {
        console.error(redact(`${error.message}\n${error.stdout}${error.stderr}`, [token]));
      } else {
        console.error(error);
      }
    }
  }
}

async function down(): Promise<void> {
  try {
    printCommandOutput(await compose(["down", "--volumes", "--remove-orphans"]));
  } finally {
    await stateFile.remove();
  }
}

async function validateConfig(): Promise<void> {
  printCommandOutput(await compose(["config", "--quiet"]));
  console.log("GitLab provider Compose configuration is valid");
}

async function runAll(): Promise<void> {
  try {
    await up();
    await seed();
    await testContract();
  } catch (error) {
    console.error(error instanceof Error ? redact(error.stack ?? error.message) : error);
    await diagnostics();
    process.exitCode = 1;
  } finally {
    try {
      await down();
    } catch (error) {
      console.error(error instanceof Error ? redact(error.stack ?? error.message) : error);
      process.exitCode = 1;
    }
  }
}

await runProviderCommand({
  config: validateConfig,
  up,
  ready: waitForReady,
  seed,
  test: testContract,
  diagnostics,
  down,
  run: runAll,
});
