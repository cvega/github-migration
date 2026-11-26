#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { mkdir, mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BitbucketServerClient } from "$lib/server/source/bitbucket/client";
import {
  bitbucketComposeFile,
  verifyBitbucketContract,
} from "../../tests/providers/bitbucket/live";
import {
  CommandError,
  type CommandOutput,
  createComposeRuntime,
  createJsonStateFile,
  execute,
  printOutput,
  redactSecrets,
  runProviderCommand,
  waitForContainerReady,
} from "./harness";

const ROOT = resolve(import.meta.dir, "../..");
const STATE_DIR = resolve(ROOT, ".provider-state");
const STATE_FILE = resolve(STATE_DIR, "bitbucket.json");
const COMPOSE_PROJECT = "github-migration-bitbucket-provider";
const BASE_URL = "http://127.0.0.1:7990";
const API_URL = `${BASE_URL}/rest/api/1.0`;
const PROJECT_KEY = "PC";
const PAGINATED_PROJECT_KEY = "PCPAGE";
const PAGINATED_REPOSITORY_COUNT = 101;

interface ProviderState {
  adminUsername: string;
  adminPassword: string;
  dbPassword: string;
  seededAt?: string;
}

const stateFile = createJsonStateFile<ProviderState>(
  STATE_FILE,
  "Bitbucket provider state is missing; run the up command first",
);

interface BitbucketProject {
  key: string;
}

interface BitbucketRepository {
  id: number;
  slug: string;
}

interface BitbucketBranch {
  displayId: string;
}

interface BitbucketPullRequest {
  id: number;
  fromRef?: { displayId?: string };
  toRef?: { displayId?: string };
}

interface BitbucketPage<T> {
  values: T[];
  isLastPage: boolean;
  nextPageStart?: number;
}

function generatedSecret(): string {
  return `provider-test-${randomBytes(24).toString("hex")}`;
}

function license(): string {
  const value = process.env.BITBUCKET_PROVIDER_LICENSE?.trim();
  if (!value) {
    throw new Error(
      "BITBUCKET_PROVIDER_LICENSE is required; obtain a Bitbucket Data Center trial or test license and export it only in the invoking terminal",
    );
  }
  return value;
}

function redact(value: string, secrets: string[] = []): string {
  return redactSecrets(value, [...secrets, process.env.BITBUCKET_PROVIDER_LICENSE ?? ""]);
}

function composeEnvironment(state: ProviderState, providerLicense = "validation-placeholder") {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: COMPOSE_PROJECT,
    BITBUCKET_PROVIDER_LICENSE: providerLicense,
    BITBUCKET_PROVIDER_ADMIN_USERNAME: state.adminUsername,
    BITBUCKET_PROVIDER_ADMIN_PASSWORD: state.adminPassword,
    BITBUCKET_PROVIDER_DB_PASSWORD: state.dbPassword,
  };
}

const composeRuntime = createComposeRuntime({
  root: ROOT,
  composeFile: bitbucketComposeFile,
  detectionEnvironment: () =>
    composeEnvironment({
      adminUsername: "provider-admin",
      adminPassword: "validation-placeholder",
      dbPassword: "validation-placeholder",
    }),
});

async function compose(arguments_: string[], state: ProviderState, providerLicense?: string) {
  return composeRuntime.run(arguments_, composeEnvironment(state, providerLicense));
}

function printCommandOutput(output: CommandOutput, secrets: string[] = []) {
  printOutput(output, (value) => redact(value, secrets));
}

async function readStateOrPlaceholder(): Promise<ProviderState> {
  try {
    return await stateFile.read();
  } catch {
    return {
      adminUsername: "provider-admin",
      adminPassword: "cleanup-placeholder",
      dbPassword: "cleanup-placeholder",
    };
  }
}

async function waitForReady(): Promise<void> {
  await waitForContainerReady({
    engine: composeRuntime.engine(),
    composeProject: COMPOSE_PROJECT,
    composeService: "bitbucket",
    providerName: "Bitbucket",
    baseUrl: BASE_URL,
    includeStopped: true,
  });
}

async function up(providerLicense = license()): Promise<void> {
  const state: ProviderState = {
    adminUsername: "provider-admin",
    adminPassword: generatedSecret(),
    dbPassword: generatedSecret(),
  };
  await stateFile.write(state);
  try {
    printCommandOutput(await compose(["up", "--detach", "bitbucket"], state, providerLicense), [
      providerLicense,
      state.adminPassword,
      state.dbPassword,
    ]);
    await waitForReady();
  } catch (error) {
    throw new Error("Bitbucket provider startup failed", { cause: error });
  }
}

function authorization(state: ProviderState): string {
  return `Basic ${Buffer.from(`${state.adminUsername}:${state.adminPassword}`).toString("base64")}`;
}

async function apiRequest<T>(
  state: ProviderState,
  path: string,
  options: { method?: string; body?: Record<string, unknown>; allowNotFound?: boolean } = {},
): Promise<T | null> {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: authorization(state),
      "Content-Type": "application/json",
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
      `Bitbucket API ${options.method ?? "GET"} ${path} failed: HTTP ${response.status} ${redact(text, [state.adminPassword]).slice(0, 2_000)}`,
    );
  }
  return text ? (JSON.parse(text) as T) : null;
}

async function paginate<T>(state: ProviderState, path: string): Promise<T[]> {
  const values: T[] = [];
  let start = 0;
  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const page = await apiRequest<BitbucketPage<T>>(
      state,
      `${path}${separator}limit=100&start=${start}`,
    );
    if (!page) throw new Error(`Bitbucket returned no page for ${path}`);
    values.push(...page.values);
    if (page.isLastPage) return values;
    if (!Number.isSafeInteger(page.nextPageStart) || (page.nextPageStart ?? -1) <= start) {
      throw new Error(`Bitbucket returned an invalid pagination cursor for ${path}`);
    }
    start = page.nextPageStart as number;
  }
}

async function ensureProject(
  state: ProviderState,
  key: string,
  name: string,
): Promise<BitbucketProject> {
  const existing = await apiRequest<BitbucketProject>(state, `/projects/${key}`, {
    allowNotFound: true,
  });
  if (existing) return existing;
  const created = await apiRequest<BitbucketProject>(state, "/projects", {
    method: "POST",
    body: {
      key,
      name,
      description: "Deterministic Bitbucket provider contract fixture",
      public: false,
      type: "NORMAL",
    },
  });
  if (!created || created.key !== key) throw new Error(`Bitbucket did not create project ${key}`);
  return created;
}

async function ensureRepository(
  state: ProviderState,
  projectKey: string,
  name: string,
  slug: string,
): Promise<BitbucketRepository> {
  const existing = await apiRequest<BitbucketRepository>(
    state,
    `/projects/${projectKey}/repos/${slug}`,
    { allowNotFound: true },
  );
  if (existing) return existing;
  const created = await apiRequest<BitbucketRepository>(state, `/projects/${projectKey}/repos`, {
    method: "POST",
    body: {
      name,
      scmId: "git",
      forkable: true,
      public: false,
    },
  });
  if (!created || created.slug !== slug) {
    throw new Error(`Bitbucket did not create repository ${projectKey}/${slug}`);
  }
  return created;
}

async function git(command: string[], cwd: string, state: ProviderState): Promise<void> {
  await execute(["git", ...command], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: ${authorization(state)}`,
    },
  });
}

async function seedRepositoryHistory(
  state: ProviderState,
  projectKey: string,
  repositorySlug: string,
  rich: boolean,
): Promise<void> {
  const branches = await paginate<BitbucketBranch>(
    state,
    `/projects/${projectKey}/repos/${repositorySlug}/branches?details=false`,
  );
  if (branches.some((branch) => branch.displayId === "main")) return;

  await using temporaryDirectory = await mkdtempDisposable(
    resolve(tmpdir(), "bitbucket-provider-"),
  );
  const directory = temporaryDirectory.path;
  await git(["init", "--initial-branch=main", "."], directory, state);
  await git(["config", "user.name", "Provider Contract"], directory, state);
  await git(["config", "user.email", "provider-contract@example.invalid"], directory, state);
  await writeFile(resolve(directory, "README.md"), `# ${repositorySlug}\n`);
  await git(["add", "README.md"], directory, state);
  await git(["commit", "-m", "Initialize repository"], directory, state);
  if (rich) {
    await mkdir(resolve(directory, "src"), { recursive: true });
    await writeFile(resolve(directory, "src/app.ts"), 'export const provider = "bitbucket";\n');
    await git(["add", "src/app.ts"], directory, state);
    await git(["commit", "-m", "Add application entrypoint"], directory, state);
    await mkdir(resolve(directory, "docs"), { recursive: true });
    await writeFile(resolve(directory, "docs/runbook.md"), "# Service runbook\n");
    await git(["add", "docs/runbook.md"], directory, state);
    await git(["commit", "-m", "Add service runbook"], directory, state);
    await git(["tag", "-a", "v1.0.0", "-m", "Provider contract release"], directory, state);
    await git(["switch", "-c", "feature/metrics"], directory, state);
    await writeFile(resolve(directory, "src/metrics.ts"), "export const metricCount = 1;\n");
    await git(["add", "src/metrics.ts"], directory, state);
    await git(["commit", "-m", "Add profile metrics"], directory, state);
    await git(["switch", "main"], directory, state);
  }
  await git(
    ["remote", "add", "origin", `${BASE_URL}/scm/${projectKey}/${repositorySlug}.git`],
    directory,
    state,
  );
  await git(["push", "origin", "--all"], directory, state);
  if (rich) await git(["push", "origin", "--tags"], directory, state);
}

async function ensurePullRequest(
  state: ProviderState,
  repository: BitbucketRepository,
): Promise<void> {
  const path = `/projects/${PROJECT_KEY}/repos/${repository.slug}/pull-requests`;
  const existing = await paginate<BitbucketPullRequest>(
    state,
    `${path}?state=ALL&direction=INCOMING`,
  );
  if (
    existing.some(
      (pullRequest) =>
        pullRequest.fromRef?.displayId === "feature/metrics" &&
        pullRequest.toRef?.displayId === "main",
    )
  ) {
    return;
  }
  const created = await apiRequest<BitbucketPullRequest>(state, path, {
    method: "POST",
    body: {
      title: "Add profile metrics endpoint",
      description: "Deterministic Bitbucket pull request fixture",
      fromRef: {
        id: "refs/heads/feature/metrics",
        repository: { slug: repository.slug, project: { key: PROJECT_KEY } },
      },
      toRef: {
        id: "refs/heads/main",
        repository: { slug: repository.slug, project: { key: PROJECT_KEY } },
      },
    },
  });
  if (!created) throw new Error(`Bitbucket did not create pull request for ${repository.slug}`);
}

async function seed(): Promise<void> {
  const state = await stateFile.read();
  await ensureProject(state, PROJECT_KEY, "Provider Contract");
  const serviceApi = await ensureRepository(state, PROJECT_KEY, "Service API", "service-api");
  await ensureRepository(state, PROJECT_KEY, "Web Client", "web-client");
  await ensureRepository(state, PROJECT_KEY, "Worker", "worker");
  for (const slug of ["service-api", "web-client", "worker"]) {
    await seedRepositoryHistory(state, PROJECT_KEY, slug, slug === "service-api");
    await apiRequest(state, `/projects/${PROJECT_KEY}/repos/${slug}/default-branch`, {
      method: "PUT",
      body: { id: "refs/heads/main" },
    });
  }
  await ensurePullRequest(state, serviceApi);

  await ensureProject(state, PAGINATED_PROJECT_KEY, "Provider Contract Pagination");
  for (let start = 1; start <= PAGINATED_REPOSITORY_COUNT; start += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, PAGINATED_REPOSITORY_COUNT - start + 1) }, (_, offset) => {
        const number = String(start + offset).padStart(3, "0");
        return ensureRepository(
          state,
          PAGINATED_PROJECT_KEY,
          `Repository ${number}`,
          `repository-${number}`,
        );
      }),
    );
  }
  await stateFile.write({ ...state, seededAt: new Date().toISOString() });
  console.log(
    `Seeded Bitbucket fixtures with repository history, branches, a tag, a pull request, and ${PAGINATED_REPOSITORY_COUNT} pagination repositories`,
  );
}

async function testContract(): Promise<void> {
  const state = await stateFile.read();
  const client = new BitbucketServerClient({
    baseUrl: BASE_URL,
    username: state.adminUsername,
    password: state.adminPassword,
    allowInsecureHttp: true,
  });
  await verifyBitbucketContract(
    client,
    PROJECT_KEY,
    PAGINATED_PROJECT_KEY,
    PAGINATED_REPOSITORY_COUNT,
  );
  console.log("Bitbucket live inventory, profile and pagination contracts passed");
}

async function diagnostics(): Promise<void> {
  const state = await readStateOrPlaceholder();
  for (const arguments_ of [
    ["ps"],
    ["logs", "--tail", "300", "postgres"],
    ["logs", "--tail", "300", "opensearch"],
    ["logs", "--tail", "300", "bitbucket"],
  ]) {
    try {
      printCommandOutput(await compose(arguments_, state), [state.adminPassword, state.dbPassword]);
    } catch (error) {
      if (error instanceof CommandError) {
        console.error(
          redact(`${error.message}\n${error.stdout}${error.stderr}`, [
            state.adminPassword,
            state.dbPassword,
          ]),
        );
      } else {
        console.error(error);
      }
    }
  }
}

async function down(): Promise<void> {
  const state = await readStateOrPlaceholder();
  try {
    printCommandOutput(await compose(["down", "--volumes", "--remove-orphans"], state), [
      state.adminPassword,
      state.dbPassword,
    ]);
  } finally {
    await stateFile.remove();
  }
}

async function validateConfig(): Promise<void> {
  const state: ProviderState = {
    adminUsername: "provider-admin",
    adminPassword: "validation-placeholder",
    dbPassword: "validation-placeholder",
  };
  printCommandOutput(await compose(["config", "--quiet"], state));
  console.log("Bitbucket provider Compose configuration is valid");
  if (!process.env.BITBUCKET_PROVIDER_LICENSE?.trim()) {
    console.log("Live startup requires BITBUCKET_PROVIDER_LICENSE");
  }
}

async function runAll(): Promise<void> {
  const providerLicense = license();
  try {
    await up(providerLicense);
    await seed();
    await seed();
    await testContract();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    await diagnostics();
    process.exitCode = 1;
  } finally {
    try {
      await down();
    } catch (error) {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
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
