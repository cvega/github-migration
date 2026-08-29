import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type MutationLaneDefinition,
  type MutationLaneId,
  type MutationRisk,
  mutationLanes,
} from "./mutation-manifest";

const repositoryRoot = resolve(import.meta.dir, "../..");
const configPattern = "tests/mutation/stryker*.conf.json";
const metadataName = "manifest-meta.json";

interface StrykerConfig {
  commandRunner?: { command?: string };
  coverageAnalysis?: string;
  incrementalFile?: string;
  jsonReporter?: { fileName?: string };
  mutate?: string[];
  thresholds?: { break?: number };
}

interface StrykerMutant {
  status: string;
}

interface StrykerReport {
  files?: Record<string, { mutants?: StrykerMutant[] }>;
}

export interface MutationMetrics {
  detected: number;
  valid: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  ignored: number;
  other: Record<string, number>;
  score: number;
}

interface LaneFingerprint {
  full: string;
  testConfig: string;
}

interface LaneMetadata {
  fingerprint: LaneFingerprint;
  mode: "forced" | "incremental";
  ranAt: string;
}

type LaneResultStatus = "passed" | "threshold-failed" | "execution-error" | "timeout-regression";

interface LaneResult {
  id: MutationLaneId;
  status: LaneResultStatus;
  mode: "forced" | "incremental";
  durationMs: number;
  reportAgeMs?: number;
  threshold: number;
  metrics?: MutationMetrics;
  exitCode: number;
  error?: string;
}

export interface ManifestValidation {
  errors: string[];
  warnings: string[];
}

interface CliOptions {
  check: boolean;
  changedBase?: string;
  force: boolean;
  laneIds: MutationLaneId[];
  risks: MutationRisk[];
}

function stripMutationSelector(path: string): string {
  return path.replace(/:\d+(?:-\d+)?(?:\[.*\])?$/, "");
}

function normalizeCommandPath(path: string): string {
  return path.replace(/^\.\//, "");
}

function testPathsFromCommand(command: string): string[] {
  return [...command.matchAll(/(?:^|\s)(?:\.\/)?([^\s]+\.test\.ts)(?=\s|$)/g)].flatMap((match) =>
    match[1] ? [normalizeCommandPath(match[1])] : [],
  );
}

async function readConfig(
  lane: MutationLaneDefinition,
  root = repositoryRoot,
): Promise<StrykerConfig> {
  return Bun.file(resolve(root, lane.configPath)).json();
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

async function existingConfigPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob(configPattern).scan({ cwd: root, onlyFiles: true })) {
    paths.push(path);
  }
  return paths.sort();
}

export async function validateMutationManifest(root = repositoryRoot): Promise<ManifestValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const configPaths: string[] = mutationLanes.map((lane) => lane.configPath);
  const reportDirectories: string[] = mutationLanes.map((lane) => lane.reportDirectory);

  for (const id of duplicates(mutationLanes.map((lane) => lane.id)))
    errors.push(`Duplicate lane id: ${id}`);
  for (const path of duplicates(configPaths)) errors.push(`Duplicate config path: ${path}`);
  for (const path of duplicates(reportDirectories))
    errors.push(`Duplicate report directory: ${path}`);

  const discoveredConfigs = await existingConfigPaths(root);
  for (const path of discoveredConfigs.filter((path) => !configPaths.includes(path))) {
    errors.push(`Unregistered Stryker config: ${path}`);
  }
  for (const path of configPaths.filter((path) => !discoveredConfigs.includes(path))) {
    errors.push(`Missing Stryker config: ${path}`);
  }

  for (const lane of mutationLanes) {
    if (lane.expectedTimeouts > 0 && !("timeoutRationale" in lane && lane.timeoutRationale)) {
      errors.push(`${lane.id}: expected timeouts require a rationale`);
    }
    for (const path of [...lane.sourcePaths, ...lane.testPaths]) {
      if (!(await Bun.file(resolve(root, path)).exists()))
        errors.push(`${lane.id}: missing input ${path}`);
    }

    let config: StrykerConfig;
    try {
      config = await readConfig(lane, root);
    } catch (error) {
      errors.push(`${lane.id}: cannot read config (${String(error)})`);
      continue;
    }

    const configuredSources = (config.mutate ?? []).map(stripMutationSelector).sort();
    const manifestSources = [...lane.sourcePaths].sort();
    if (JSON.stringify(configuredSources) !== JSON.stringify(manifestSources)) {
      errors.push(`${lane.id}: manifest source paths do not match config mutate paths`);
    }

    const command = config.commandRunner?.command ?? "";
    const configuredTests = testPathsFromCommand(command).sort();
    const manifestTests = [...lane.testPaths].sort();
    if (JSON.stringify(configuredTests) !== JSON.stringify(manifestTests)) {
      errors.push(`${lane.id}: manifest test paths do not match command runner paths`);
    }
    if (!command.startsWith("bun test --env-file=/dev/null ")) {
      errors.push(`${lane.id}: command runner must use deterministic Bun test environment`);
    }

    const reportPath = config.jsonReporter?.fileName;
    if (!reportPath || dirname(reportPath) !== lane.reportDirectory) {
      errors.push(`${lane.id}: JSON report path does not match manifest report directory`);
    }
    if (config.coverageAnalysis !== "off") {
      errors.push(`${lane.id}: coverageAnalysis must remain off for the command runner`);
    }
    if (!Number.isFinite(config.thresholds?.break))
      errors.push(`${lane.id}: break threshold is missing`);
    if (!config.incrementalFile) warnings.push(`${lane.id}: incremental file is not configured`);
  }

  return { errors, warnings };
}

export function mutationMetrics(report: StrykerReport): MutationMetrics {
  const statusCounts: Record<string, number> = {};
  for (const file of Object.values(report.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      statusCounts[mutant.status] = (statusCounts[mutant.status] ?? 0) + 1;
    }
  }
  const killed = statusCounts.Killed ?? 0;
  const survived = statusCounts.Survived ?? 0;
  const timeout = statusCounts.Timeout ?? 0;
  const noCoverage = statusCounts.NoCoverage ?? 0;
  const ignored = statusCounts.Ignored ?? 0;
  const detected = killed + timeout;
  const valid = detected + survived + noCoverage;
  const knownStatuses = new Set(["Killed", "Survived", "Timeout", "NoCoverage", "Ignored"]);
  const other = Object.fromEntries(
    Object.entries(statusCounts).filter(([status]) => !knownStatuses.has(status)),
  );
  return {
    detected,
    valid,
    killed,
    survived,
    timeout,
    noCoverage,
    ignored,
    other,
    score: valid === 0 ? 100 : (detected / valid) * 100,
  };
}

async function hashFiles(root: string, paths: string[], extra: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(extra);
  for (const path of [...new Set(paths)].sort()) {
    hasher.update(`\0${path}\0`);
    hasher.update(await Bun.file(resolve(root, path)).arrayBuffer());
  }
  return hasher.digest("hex");
}

async function laneFingerprint(
  lane: MutationLaneDefinition,
  root = repositoryRoot,
): Promise<LaneFingerprint> {
  const packageJson = await Bun.file(resolve(root, "package.json")).json();
  const toolVersions = JSON.stringify({
    bun: packageJson.packageManager,
    stryker: packageJson.devDependencies?.["@stryker-mutator/core"],
  });
  const sharedPaths = [lane.configPath, ...lane.testPaths, "bun.lock", "package.json"];
  const testConfig = await hashFiles(root, sharedPaths, toolVersions);
  const full = await hashFiles(root, [...sharedPaths, ...lane.sourcePaths], toolVersions);
  return { full, testConfig };
}

async function readMetadata(path: string): Promise<LaneMetadata | undefined> {
  try {
    return await Bun.file(path).json();
  } catch {
    return undefined;
  }
}

async function fileModifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function runLane(
  lane: (typeof mutationLanes)[number],
  options: { force: boolean },
  root = repositoryRoot,
): Promise<LaneResult> {
  const config = await readConfig(lane, root);
  const threshold = config.thresholds?.break ?? Number.NaN;
  const reportPath = resolve(root, config.jsonReporter?.fileName ?? "");
  const metadataPath = resolve(root, lane.reportDirectory, metadataName);
  const fingerprint = await laneFingerprint(lane, root);
  const previousMetadata = await readMetadata(metadataPath);
  const force =
    options.force || previousMetadata?.fingerprint.testConfig !== fingerprint.testConfig;
  const mode = force ? "forced" : "incremental";
  const previousReportModifiedAt = await fileModifiedAt(reportPath);
  const startedAt = Date.now();

  console.log(`\n[mutation:${lane.id}] ${mode}`);
  const process = Bun.spawn(
    ["bun", "--bun", "stryker", "run", ...(force ? ["--force"] : []), lane.configPath],
    { cwd: root, stdout: "inherit", stderr: "inherit", env: processEnv() },
  );
  const exitCode = await process.exited;
  const finishedAt = Date.now();
  const reportModifiedAt = await fileModifiedAt(reportPath);
  let metrics: MutationMetrics | undefined;
  let error: string | undefined;

  if (reportModifiedAt && reportModifiedAt !== previousReportModifiedAt) {
    try {
      metrics = mutationMetrics(await Bun.file(reportPath).json());
    } catch (reportError) {
      error = `Could not parse fresh report: ${String(reportError)}`;
    }
  } else {
    error = "Stryker did not produce a fresh JSON report";
  }

  let status: LaneResultStatus = "passed";
  if (!metrics || (exitCode !== 0 && metrics.score >= threshold)) status = "execution-error";
  else if (metrics.score < threshold) status = "threshold-failed";
  else if (metrics.timeout > lane.expectedTimeouts) status = "timeout-regression";

  if (metrics) {
    await Bun.write(
      metadataPath,
      `${JSON.stringify({ fingerprint, mode, ranAt: new Date(finishedAt).toISOString() }, null, 2)}\n`,
    );
  }

  return {
    id: lane.id,
    status,
    mode,
    durationMs: finishedAt - startedAt,
    reportAgeMs: reportModifiedAt ? finishedAt - reportModifiedAt : undefined,
    threshold,
    metrics,
    exitCode,
    error,
  };
}

function processEnv(): Record<string, string | undefined> {
  return { ...Bun.env };
}

function optionValue(args: string[], index: number, name: string): [string, number] {
  const arg = args[index];
  if (!arg) throw new Error(`${name} requires a value`);
  const inline = arg.slice(name.length + 1);
  if (inline) return [inline, index];
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return [next, index + 1];
}

export function parseMutationArgs(args: string[]): CliOptions {
  const options: CliOptions = { check: false, force: false, laneIds: [], risks: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--force") options.force = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--lane" || arg.startsWith("--lane=")) {
      const [value, consumedIndex] = optionValue(args, index, "--lane");
      index = consumedIndex;
      for (const id of value.split(",")) {
        if (!mutationLanes.some((lane) => lane.id === id))
          throw new Error(`Unknown mutation lane: ${id}`);
        options.laneIds.push(id as MutationLaneId);
      }
    } else if (arg === "--risk" || arg.startsWith("--risk=")) {
      const [value, consumedIndex] = optionValue(args, index, "--risk");
      index = consumedIndex;
      for (const risk of value.split(",")) {
        if (!(["critical", "high", "standard"] as string[]).includes(risk)) {
          throw new Error(`Unknown mutation risk: ${risk}`);
        }
        options.risks.push(risk as MutationRisk);
      }
    } else if (arg === "--changed" || arg.startsWith("--changed=")) {
      const [value, consumedIndex] = optionValue(args, index, "--changed");
      index = consumedIndex;
      options.changedBase = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function changedPaths(base: string, root = repositoryRoot): Promise<string[]> {
  const process = Bun.spawn(["git", "diff", "--name-only", base], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, output, errorOutput] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Could not resolve changed paths: ${errorOutput.trim()}`);
  return output
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
}

export function lanesForPaths(paths: string[]): (typeof mutationLanes)[number][] {
  const allLaneInputs = new Set([
    "bun.lock",
    "package.json",
    "scripts/checks/mutation-manifest.ts",
    "scripts/checks/mutation-runner.ts",
  ]);
  if (paths.some((path) => allLaneInputs.has(path))) return [...mutationLanes];
  return mutationLanes.filter((lane) =>
    paths.some(
      (path) =>
        path === lane.configPath ||
        (lane.sourcePaths as readonly string[]).includes(path) ||
        (lane.testPaths as readonly string[]).includes(path),
    ),
  );
}

function selectLanes(options: CliOptions, changed: string[]): (typeof mutationLanes)[number][] {
  let selected = options.changedBase ? lanesForPaths(changed) : [...mutationLanes];
  if (options.laneIds.length > 0) {
    selected = selected.filter((lane) => options.laneIds.includes(lane.id));
  }
  if (options.risks.length > 0)
    selected = selected.filter((lane) => options.risks.includes(lane.risk));
  return selected;
}

function formatResult(result: LaneResult): string {
  if (!result.metrics) return `${result.id}: ${result.status} (${result.error ?? "no report"})`;
  const { detected, valid, score, survived, timeout } = result.metrics;
  return `${result.id}: ${result.status} ${detected}/${valid} (${score.toFixed(4)}%, floor ${result.threshold.toFixed(4)}%) survivors=${survived} timeouts=${timeout} mode=${result.mode}`;
}

async function writeAggregate(results: LaneResult[], root = repositoryRoot): Promise<void> {
  const aggregatePath = resolve(root, "reports/mutation/aggregate.json");
  await Bun.write(
    aggregatePath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ok: results.every((result) => result.status === "passed"),
        results,
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const options = parseMutationArgs(Bun.argv.slice(2));
  const validation = await validateMutationManifest();
  for (const warning of validation.warnings) console.warn(`warning: ${warning}`);
  if (validation.errors.length > 0) throw new Error(validation.errors.join("\n"));
  if (options.check) {
    console.log(`Mutation manifest check passed: ${mutationLanes.length} lanes`);
    return;
  }

  const changed = options.changedBase ? await changedPaths(options.changedBase) : [];
  const selected = selectLanes(options, changed);
  if (selected.length === 0) {
    console.log("No mutation lanes selected");
    return;
  }

  const results: LaneResult[] = [];
  for (const lane of selected) results.push(await runLane(lane, options));
  await writeAggregate(results);

  console.log("\nMutation summary");
  for (const result of results) console.log(formatResult(result));
  if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
