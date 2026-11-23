import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExporterSandboxPolicy } from "$lib/server/core/exporter-sandbox";
import type {
  ExporterArchiveRequest,
  ExporterJobStatus,
  ExporterSourceProvider,
  ExporterWorker,
} from "./worker";

export interface DockerExporterConfig {
  exporterRuntime: string;
  exporterImage: string;
  exporterArchiveVolume: string;
  archiveDirectory: string;
  sandbox: ExporterSandboxPolicy;
}
interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface DockerExporterDependencies {
  run(
    args: string[],
    signal?: AbortSignal,
    environment?: Record<string, string>,
  ): Promise<CommandResult>;
  hash(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  statDirectory(path: string): Promise<{ isDirectory(): boolean; uid: number; gid: number }>;
  remove(path: string): Promise<void>;
}
export interface DockerExporterDefinition {
  provider: ExporterSourceProvider;
  jobPrefix: string;
  displayName: string;
  validate?(request: ExporterArchiveRequest): void;
  command(
    request: ExporterArchiveRequest,
    output: string,
  ): { environment: string[]; arguments: string[] };
}

const MAX_OUTPUT = 64 * 1024;
async function bounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes <= MAX_OUTPUT) result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}
async function run(
  args: string[],
  signal?: AbortSignal,
  environment?: Record<string, string>,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: environment ? { ...process.env, ...environment } : process.env,
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      bounded(child.stdout),
      bounded(child.stderr),
      child.exited,
    ]);
    signal?.throwIfAborted();
    return { stdout, stderr, exitCode };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
function defaults(): DockerExporterDependencies {
  return {
    run,
    hash,
    stat: lstat,
    statDirectory: stat,
    remove: (path) => rm(path, { force: true }),
  };
}
function failure(name: string, action: string, result: CommandResult): Error {
  return new Error(
    `${name} container ${action} failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`,
  );
}

export class DockerExporterWorker implements ExporterWorker {
  constructor(
    readonly config: DockerExporterConfig,
    readonly definition: DockerExporterDefinition,
    readonly dependencies: DockerExporterDependencies = defaults(),
  ) {}
  identify(request: ExporterArchiveRequest): string {
    const normalized = request.migrationId
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "-")
      .slice(0, 50);
    if (!normalized) throw new TypeError("Migration ID cannot form an exporter container name");
    return `${this.definition.jobPrefix}-${normalized}`;
  }
  async submit(request: ExporterArchiveRequest, signal?: AbortSignal): Promise<{ jobId: string }> {
    if (request.sourceProvider !== this.definition.provider)
      throw new TypeError(`${this.definition.displayName} source mismatch`);
    this.definition.validate?.(request);
    const jobId = this.identify(request);
    const archiveName = `${jobId}.tar.gz`;
    await this.dependencies.remove(resolve(this.config.archiveDirectory, archiveName));
    const command = this.definition.command(request, `/workspace/${archiveName}`);
    const environment = Object.fromEntries(
      command.environment.map((entry) => {
        const separator = entry.indexOf("=");
        if (separator < 1) throw new TypeError("Exporter environment entry must use NAME=value");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    const environmentArgs = Object.keys(environment).flatMap((name) => ["-e", name]);
    const sandbox = this.config.sandbox;
    const archiveDirectory = await this.dependencies.statDirectory(this.config.archiveDirectory);
    if (!archiveDirectory.isDirectory())
      throw new TypeError("Exporter archive path is not a directory");
    try {
      const created = await this.dependencies.run(
        [
          this.config.exporterRuntime,
          "create",
          "--name",
          jobId,
          "--label",
          `com.github-migration.migration-id=${request.migrationId}`,
          "--read-only",
          "--user",
          `${archiveDirectory.uid}:${archiveDirectory.gid}`,
          "--tmpfs",
          `/tmp:rw,noexec,nosuid,nodev,size=${sandbox.tmpfsSize}`,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          String(sandbox.pidsLimit),
          "--memory",
          sandbox.memory,
          "--cpus",
          String(sandbox.cpus),
          "--network",
          sandbox.network,
          "--mount",
          `type=volume,source=${this.config.exporterArchiveVolume},target=/workspace`,
          ...environmentArgs,
          this.config.exporterImage,
          ...command.arguments,
        ],
        signal,
        environment,
      );
      if (created.exitCode !== 0) throw failure(this.definition.displayName, "create", created);
      const started = await this.dependencies.run(
        [this.config.exporterRuntime, "start", jobId],
        signal,
      );
      if (started.exitCode !== 0) throw failure(this.definition.displayName, "start", started);
    } catch (error) {
      await this.cleanup(jobId).catch(() => {});
      throw error;
    }
    return { jobId };
  }
  async inspect(jobId: string, signal?: AbortSignal): Promise<ExporterJobStatus> {
    const inspected = await this.dependencies.run(
      [this.config.exporterRuntime, "inspect", "--format", "{{json .State}}", jobId],
      signal,
    );
    if (inspected.exitCode !== 0) throw failure(this.definition.displayName, "inspect", inspected);
    let state: { Status?: unknown; Running?: unknown; ExitCode?: unknown; Error?: unknown };
    try {
      state = JSON.parse(inspected.stdout);
    } catch (cause) {
      throw new Error(`${this.definition.displayName} returned invalid container state`, { cause });
    }
    if (state.Running === true || state.Status === "created")
      return { jobId, state: state.Status === "created" ? "queued" : "running" };
    if (state.Status !== "exited" || !Number.isInteger(state.ExitCode))
      return { jobId, state: "failed", failureReason: "Exporter container stopped unexpectedly" };
    if (state.ExitCode !== 0) {
      const logs = await this.dependencies.run(
        [this.config.exporterRuntime, "logs", "--tail", "200", jobId],
        signal,
      );
      return {
        jobId,
        state: "failed",
        failureReason:
          logs.stderr.trim() || logs.stdout.trim() || String(state.Error || "Exporter failed"),
      };
    }
    const path = resolve(this.config.archiveDirectory, `${jobId}.tar.gz`);
    const archive = await this.dependencies.stat(path);
    if (!archive.isFile() || archive.isSymbolicLink())
      return { jobId, state: "failed", failureReason: "Exporter archive is not a regular file" };
    return {
      jobId,
      state: "succeeded",
      archive: { path, sha256: await this.dependencies.hash(path) },
    };
  }
  async cancel(jobId: string, signal?: AbortSignal): Promise<void> {
    const result = await this.dependencies.run(
      [this.config.exporterRuntime, "stop", "--time", "30", jobId],
      signal,
    );
    if (result.exitCode !== 0) throw failure(this.definition.displayName, "stop", result);
  }
  async cleanup(jobId: string): Promise<void> {
    const result = await this.dependencies.run([
      this.config.exporterRuntime,
      "rm",
      "--force",
      jobId,
    ]);
    if (result.exitCode !== 0 && !result.stderr.includes("No such container"))
      throw failure(this.definition.displayName, "cleanup", result);
  }
}
