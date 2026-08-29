import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const COMMAND_TIMEOUT_MS = 20 * 60 * 1_000;
const STARTUP_TIMEOUT_MS = 15 * 60 * 1_000;
const POLL_INTERVAL_MS = 5_000;

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    readonly command: string[],
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command.join(" ")} exited with code ${exitCode}`);
    this.name = "CommandError";
  }
}

export async function execute(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<CommandOutput> {
  const processHandle = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    processHandle.kill("SIGKILL");
  }, COMMAND_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]).finally(() => clearTimeout(timeout));
  if (timedOut) {
    throw new Error(`${command.join(" ")} timed out after ${COMMAND_TIMEOUT_MS / 60_000} minutes`);
  }
  if (exitCode !== 0) throw new CommandError(command, exitCode, stdout, stderr);
  return { stdout, stderr };
}

interface ContainerReadinessOptions {
  engine: string;
  composeProject: string;
  composeService: string;
  providerName: string;
  baseUrl: string;
  includeStopped?: boolean;
}

export async function waitForContainerReady(options: ContainerReadinessOptions): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let nextProgressAt = Date.now();
  while (Date.now() < deadline) {
    const containerIds = await execute([
      options.engine,
      "ps",
      ...(options.includeStopped ? ["--all"] : []),
      "--filter",
      `label=com.docker.compose.project=${options.composeProject}`,
      "--filter",
      `label=com.docker.compose.service=${options.composeService}`,
      "--format",
      "{{.ID}}",
    ]);
    const containerId = containerIds.stdout.trim();
    if (!containerId || containerId.includes("\n")) {
      throw new Error(`Expected exactly one ${options.providerName} provider container`);
    }
    const health = await execute([
      options.engine,
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      containerId,
    ]);
    const status = health.stdout.trim();
    if (status === "healthy") {
      console.log(`${options.providerName} is ready at ${options.baseUrl}`);
      return;
    }
    if (status !== "starting") {
      throw new Error(
        `${options.providerName} container entered unexpected health state: ${status || "unknown"}`,
      );
    }
    if (Date.now() >= nextProgressAt) {
      console.log(`Waiting for ${options.providerName} readiness (${status})`);
      nextProgressAt = Date.now() + 30_000;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `${options.providerName} did not become ready within ${STARTUP_TIMEOUT_MS / 60_000} minutes`,
  );
}

interface ComposeRuntimeOptions {
  root: string;
  composeFile: string;
  detectionEnvironment: () => Record<string, string | undefined>;
}

export function createComposeRuntime(options: ComposeRuntimeOptions) {
  let detectedCommand: string[] | undefined;

  function command(): string[] {
    if (detectedCommand) return detectedCommand;
    const candidates = [["docker", "compose"], ["podman-compose"], ["docker-compose"]];
    for (const candidate of candidates) {
      const result = Bun.spawnSync([...candidate, "-f", options.composeFile, "ps"], {
        cwd: options.root,
        env: options.detectionEnvironment(),
        stdout: "ignore",
        stderr: "ignore",
      });
      if (result.exitCode === 0) {
        detectedCommand = candidate;
        return candidate;
      }
    }
    throw new Error(
      "A working Compose provider is required (docker compose, podman-compose, or docker-compose)",
    );
  }

  return {
    engine(): string {
      return command()[0] === "podman-compose" ? "podman" : "docker";
    },
    run(
      arguments_: string[],
      environment: Record<string, string | undefined> = options.detectionEnvironment(),
    ): Promise<CommandOutput> {
      return execute([...command(), "-f", options.composeFile, ...arguments_], {
        cwd: options.root,
        env: environment,
      });
    },
  };
}

export function redactSecrets(
  value: string,
  secrets: string[] = [],
  patterns: RegExp[] = [],
): string {
  let redacted = value;
  for (const pattern of patterns) redacted = redacted.replace(pattern, "[REDACTED]");
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

export function printOutput(output: CommandOutput, redact: (value: string) => string): void {
  const text = redact(`${output.stdout}${output.stderr}`).trim();
  if (text) console.log(text);
}

export function createJsonStateFile<T>(path: string, missingMessage: string) {
  return {
    async write(state: T): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    },
    async read(): Promise<T> {
      try {
        return JSON.parse(await readFile(path, "utf8")) as T;
      } catch (cause) {
        throw new Error(missingMessage, { cause });
      }
    },
    async remove(): Promise<void> {
      await rm(path, { force: true });
    },
  };
}

type ProviderCommand = "config" | "up" | "ready" | "seed" | "test" | "diagnostics" | "down" | "run";

type ProviderCommands = Record<ProviderCommand, () => Promise<void>>;

export async function runProviderCommand(commands: ProviderCommands): Promise<void> {
  const command = process.argv[2] ?? "run";
  if (!(command in commands)) {
    throw new TypeError(
      `Unknown command ${command}; expected config, up, ready, seed, test, diagnostics, down, or run`,
    );
  }
  await commands[command as ProviderCommand]();
}
