#!/usr/bin/env bun
/**
 * gates — run the full gate suite and emit a compact JSON summary instead
 * of `verify`'s ~150 lines of human output (the vite build chunk listing alone
 * is a large, low-signal block). Built for AI / automated consumption:
 *
 *   - one JSON object: { ok, ms, failures, gates: { <gate>: { ok, ms, metrics } } }
 *   - per-gate metrics are parsed from each tool's output (errors, coverage %,
 *     clone count, vuln count, …)
 *   - only FAILING gates carry a trimmed `error` excerpt, so a green run is tiny
 *     and a red run still contains enough to act without re-running
 *   - exits non-zero iff any gate failed → drop-in for CI / an agent check
 *
 * The gate commands are read from package.json (single source of truth, so this
 * can't drift from `verify`), so a pass here means the same as a `verify` pass.
 * The gates run CONCURRENTLY: `.svelte-kit/` is generated once up front and the
 * redundant per-script `svelte-kit sync` prefix is stripped, so during the
 * parallel phase nothing rewrites it and the type-aware readers see a stable
 * tree. Concurrency is bounded (defaults to the machine's available
 * parallelism; override with GATES_CONCURRENCY) so small CI runners stagger the
 * heavy gates instead of OOM-racing them. Pass gate names to run a subset, e.g.
 *   bun run gates typecheck lint
 */
import { availableParallelism } from "node:os";

// Strip ANSI colour codes (built from charCode 27 to avoid a literal control char).
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string): string => s.replace(ansi, "");

type Metrics = Record<string, number | string>;

interface GateResult {
  ok: boolean;
  ms: number;
  metrics?: Metrics;
  /** Trimmed output excerpt — present only when the gate failed. */
  error?: string;
}

// Put node_modules/.bin on PATH so gate scripts that invoke bare binaries
// (jscpd, knip, madge) resolve exactly as they do under `bun run`.
const binDir = new URL("../node_modules/.bin", import.meta.url).pathname;
const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

async function run(cmd: string[]): Promise<{ code: number; out: string; ms: number }> {
  const t0 = Date.now();
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? 1, out: strip(stdout + stderr), ms: Date.now() - t0 };
}

/** Last `n` non-empty lines — a compact, actionable failure excerpt. */
function tail(out: string, n = 15): string {
  const lines = out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  return lines.slice(-n).join("\n");
}

const int = (re: RegExp, out: string): number | undefined => {
  const m = out.match(re);
  return m?.[1] != null ? Number(m[1]) : undefined;
};

interface Gate {
  name: string;
  /** package.json script key this gate runs (the single source of truth). */
  script: string;
  parse?: (out: string) => Metrics;
}

const GATES: Gate[] = [
  {
    name: "typecheck",
    script: "typecheck",
    parse: (o) => ({ errors: (o.match(/error TS\d+/g) ?? []).length }),
  },
  {
    name: "check",
    script: "check",
    parse: (o): Metrics => {
      const m = o.match(/found (\d+) errors? and (\d+) warnings?/i);
      return m ? { errors: Number(m[1]), warnings: Number(m[2]) } : {};
    },
  },
  // `lint` runs `biome check` (lint + formatter + organize-imports/assist);
  // `format` is the explicit formatter-only check.
  { name: "lint", script: "lint" },
  { name: "format", script: "format:check" },
  {
    name: "coverage",
    script: "coverage:check",
    parse: (o): Metrics => {
      // Success line: "✓ Coverage gate passed — functions 88.38% (…), lines 85.66% (…)"
      const m = o.match(/functions ([\d.]+)%.*?lines ([\d.]+)%/s);
      return m ? { funcPct: Number(m[1]), linePct: Number(m[2]) } : {};
    },
  },
  {
    name: "dup",
    script: "dup",
    parse: (o) => {
      const r: Metrics = {};
      const clones = int(/Found (\d+) clones/, o);
      if (clones != null) r.clones = clones;
      // jscpd Total row: "… │ N │ … (1.27%) │ … (1.75%) │"
      const pct = o.match(/Total:.*?\(([\d.]+)%\).*?\(([\d.]+)%\)/);
      if (pct) {
        r.linePct = Number(pct[1]);
        r.tokenPct = Number(pct[2]);
      }
      return r;
    },
  },
  { name: "deadcode", script: "deadcode" },
  { name: "cycles", script: "cycles" },
  { name: "boundaries", script: "boundaries" },
  {
    name: "build",
    script: "build",
    parse: (o): Metrics => {
      const m = o.match(/built in ([\d.]+)\s*s/);
      return m ? { builtInS: Number(m[1]) } : {};
    },
  },
  {
    name: "audit",
    script: "audit",
    parse: (o) => ({ vulnerabilities: int(/(\d+) vulnerabilit/i, o) ?? 0 }),
  },
];

// Gate commands come straight from package.json (single source of truth, so
// `gates` can't drift from `verify`), with the redundant per-script
// `svelte-kit sync` prefix stripped — the suite syncs ONCE up front (below), so
// the concurrent gates never rewrite `.svelte-kit/` underneath each other.
const pkg = (await Bun.file(new URL("../package.json", import.meta.url).pathname).json()) as {
  scripts?: Record<string, string>;
};
const scripts = pkg.scripts ?? {};
const SYNC_PREFIX = /^\s*bunx\s+--bun\s+svelte-kit\s+sync\s*&&\s*/;

/** Resolve a gate to its shell command: the package.json script body, minus the
 *  redundant sync prefix, run via `sh -c` so its `&&` chains work. */
function gateCmd(g: Gate): string[] {
  const body = scripts[g.script];
  if (!body) throw new Error(`package.json has no "${g.script}" script for gate "${g.name}"`);
  return ["sh", "-c", body.replace(SYNC_PREFIX, "")];
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = requested.length
  ? GATES.filter((g) => requested.includes(g.name))
  : GATES;

if (requested.length && selected.length !== requested.length) {
  const unknown = requested.filter((r) => !GATES.some((g) => g.name === r));
  console.error(
    JSON.stringify({
      ok: false,
      error: `unknown gate(s): ${unknown.join(", ")}`,
      available: GATES.map((g) => g.name),
    }),
  );
  process.exit(2);
}

const t0 = Date.now();
const gates: Record<string, GateResult> = {};
const failures: string[] = [];

// Prepare: generate SvelteKit's `.svelte-kit/` (the $types + $lib path aliases)
// ONCE, up front. On a fresh checkout it doesn't exist yet, and without it both
// `tsc` (typecheck) and `bun test` ($lib import resolution) fail. This is also
// the barrier that makes the gates safe to run concurrently: it completes before
// any gate starts, and the gate commands have their own `svelte-kit sync` prefix
// stripped (see gateCmd), so nothing rewrites `.svelte-kit/` during the parallel
// phase — the only writer left is `build`, into its own `.svelte-kit/output` +
// `build/`.
const sync = await run(["bunx", "--bun", "svelte-kit", "sync"]);
if (sync.code !== 0) {
  console.log(
    JSON.stringify({
      ok: false,
      ms: Date.now() - t0,
      failures: ["prepare"],
      gates: { prepare: { ok: false, ms: sync.ms, error: tail(sync.out) } },
    }),
  );
  process.exit(1);
}

// Run the gates concurrently with a bounded worker pool. The cap defaults to the
// machine's available parallelism, so a big dev box runs the whole suite at once
// while a small CI runner staggers the heavy gates (build / check / typecheck /
// coverage) instead of OOM-racing them; override with GATES_CONCURRENCY.
const concurrency = Math.max(1, Number(process.env.GATES_CONCURRENCY) || availableParallelism());
const results = new Map<string, GateResult>();
let next = 0;
async function worker(): Promise<void> {
  while (next < selected.length) {
    const g = selected[next++];
    if (!g) break;
    const { code, out, ms } = await run(gateCmd(g));
    const ok = code === 0;
    const metrics = g.parse?.(out);
    results.set(g.name, {
      ok,
      ms,
      ...(metrics && Object.keys(metrics).length ? { metrics } : {}),
      ...(ok ? {} : { error: tail(out) }),
    });
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));

// Assemble output in GATES order (deterministic, independent of finish order).
for (const g of selected) {
  const r = results.get(g.name);
  if (!r) continue;
  gates[g.name] = r;
  if (!r.ok) failures.push(g.name);
}

const summary = { ok: failures.length === 0, ms: Date.now() - t0, failures, gates };

// Minified when green (fewest tokens); indented when red so excerpts are readable.
console.log(JSON.stringify(summary, null, failures.length ? 2 : 0));
process.exit(failures.length ? 1 : 0);
