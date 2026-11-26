import { createHash } from "node:crypto";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { sourceBaseUrl } from "$lib/source-provider";
import type {
  ClaimedRepositoryAnalysisJob,
  RepositoryAnalysisResultInput,
} from "../database/repository-analysis-jobs";

const GIB = 1024 ** 3;
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60_000;

/** A locally constructed diagnostic safe to persist in a job and show on its profile. */
export class RepositoryAnalysisError extends Error {}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RepositoryAnalyzerDependencies {
  run(
    command: string[],
    options: { cwd?: string; environment?: Record<string, string>; timeoutMs: number },
  ): Promise<CommandResult>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  workspaceCapacity(path: string): Promise<{ capacityBytes: number; freeBytes: number }>;
  getSourceToken(sourceApiUrl: string, nameWithOwner: string): Promise<string>;
}

export interface RepositoryAnalyzerOptions {
  workspaceRoot: string;
  timeoutMs?: number;
  operationalCeilingBytes?: number;
}

async function bounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes <= MAX_OUTPUT_BYTES) output += decoder.decode(value, { stream: true });
  }
  if (bytes > MAX_OUTPUT_BYTES)
    throw new RepositoryAnalysisError("Analyzer command output exceeded 512 KiB");
  return output + decoder.decode();
}

export async function runAnalyzerCommand(
  command: string[],
  options: { cwd?: string; environment?: Record<string, string>; timeoutMs: number },
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.environment ? { ...process.env, ...options.environment } : process.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      bounded(child.stdout),
      bounded(child.stderr),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_DEPS: Omit<RepositoryAnalyzerDependencies, "getSourceToken"> = {
  run: runAnalyzerCommand,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  remove: (path) => rm(path, { recursive: true, force: true }),
  workspaceCapacity: async (path) => {
    const stats = await statfs(path);
    return { capacityBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  },
};

async function successful(
  dependencies: RepositoryAnalyzerDependencies,
  label: string,
  command: string[],
  options: { cwd?: string; environment?: Record<string, string>; timeoutMs: number },
): Promise<string> {
  const result = await dependencies.run(command, options);
  if (result.exitCode !== 0)
    throw new RepositoryAnalysisError(`${label} failed (exit code ${result.exitCode})`);
  return result.stdout.trim();
}

function normalizeLfsPointers(raw: string): RepositoryAnalysisResultInput["lfsPointers"] {
  const invalid = () =>
    new RepositoryAnalysisError("Git LFS returned an invalid pointer inventory");
  const parsed: unknown = JSON.parse(raw || "[]");
  if (!parsed || typeof parsed !== "object" || !("files" in parsed)) {
    throw invalid();
  }
  const files = parsed.files;
  if (files === null) return [];
  if (!Array.isArray(files)) throw invalid();
  const pointers = new Map<
    string,
    { oid: string; declaredSizeBytes: number; representativePath: string }
  >();
  for (const item of files) {
    if (!item || typeof item !== "object") throw invalid();
    const candidate = item as Record<string, unknown>;
    const hash = typeof candidate.oid === "string" ? candidate.oid : null;
    const oidType = typeof candidate.oid_type === "string" ? candidate.oid_type : null;
    const oid = hash && oidType ? `${oidType}:${hash}` : null;
    const path = typeof candidate.name === "string" ? candidate.name : null;
    const size = typeof candidate.size === "number" ? candidate.size : null;
    if (!oid || !path || size === null || !Number.isSafeInteger(size) || size < 0) throw invalid();
    if (!pointers.has(oid))
      pointers.set(oid, { oid, declaredSizeBytes: size, representativePath: path });
  }
  return [...pointers.values()];
}

export async function analyzeRepository(
  job: ClaimedRepositoryAnalysisJob,
  options: RepositoryAnalyzerOptions,
  overrides: Partial<RepositoryAnalyzerDependencies> &
    Pick<RepositoryAnalyzerDependencies, "getSourceToken">,
): Promise<RepositoryAnalysisResultInput> {
  const dependencies: RepositoryAnalyzerDependencies = { ...DEFAULT_DEPS, ...overrides };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await dependencies.mkdir(options.workspaceRoot);
  const workspace = join(
    options.workspaceRoot,
    job.analysisRunId,
    String(job.profileRepoId),
    String(job.attempt),
  );
  const mirror = join(workspace, "mirror.git");
  const capacity = await dependencies.workspaceCapacity(options.workspaceRoot);
  const reserveBytes = Math.max(5 * GIB, Math.ceil(capacity.capacityBytes * 0.1));
  const usableBytes = Math.max(
    0,
    Math.min(
      capacity.freeBytes - reserveBytes,
      options.operationalCeilingBytes ?? Number.MAX_SAFE_INTEGER,
    ),
  );
  if (job.estimatedWorkspaceBytes !== null && job.estimatedWorkspaceBytes > usableBytes) {
    throw new RepositoryAnalysisError(
      `insufficient_workspace: requires ${job.estimatedWorkspaceBytes} bytes; ${usableBytes} bytes available above reserve`,
    );
  }

  await dependencies.remove(workspace);
  await dependencies.mkdir(workspace);
  try {
    const token = await dependencies.getSourceToken(job.sourceApiUrl, job.nameWithOwner);
    const cloneUrl = `${sourceBaseUrl(job.sourceApiUrl)}/${job.nameWithOwner}.git`;
    const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
    const gitEnvironment = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${cloneUrl}.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    };
    await successful(
      dependencies,
      "Git mirror clone",
      ["git", "clone", "--mirror", cloneUrl, mirror],
      {
        environment: gitEnvironment,
        timeoutMs,
      },
    );

    const commandOptions = { cwd: mirror, timeoutMs };
    const [rawSizer, rawLfs, refs, du, gitVersion, gitLfsVersion, gitSizerVersion] =
      await Promise.all([
        successful(
          dependencies,
          "git-sizer",
          ["git-sizer", "--json", "--json-version=2"],
          commandOptions,
        ),
        successful(
          dependencies,
          "Git LFS inventory",
          ["git", "lfs", "ls-files", "--all", "--json"],
          commandOptions,
        ),
        successful(
          dependencies,
          "Git ref fingerprint",
          ["git", "for-each-ref", "--format=%(refname) %(objectname)"],
          commandOptions,
        ),
        successful(dependencies, "Mirror size", ["du", "-sk", "."], commandOptions),
        successful(dependencies, "Git version", ["git", "--version"], commandOptions),
        successful(dependencies, "Git LFS version", ["git", "lfs", "version"], commandOptions),
        successful(dependencies, "git-sizer version", ["git-sizer", "--version"], commandOptions),
      ]);
    const mirrorKilobytes = Number.parseInt(du.split(/\s+/)[0] ?? "", 10);
    if (!Number.isSafeInteger(mirrorKilobytes) || mirrorKilobytes < 0) {
      throw new RepositoryAnalysisError("Unable to determine mirror workspace size");
    }
    return {
      sourceRefFingerprint: `sha256:${createHash("sha256").update(refs).digest("hex")}`,
      mirrorSizeBytes: mirrorKilobytes * 1024,
      gitVersion,
      gitLfsVersion,
      gitSizerVersion,
      metrics: JSON.parse(rawSizer) as unknown,
      rawArtifact: rawSizer,
      lfsPointers: normalizeLfsPointers(rawLfs),
    };
  } finally {
    await dependencies.remove(workspace);
  }
}
