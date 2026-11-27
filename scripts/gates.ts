#!/usr/bin/env bun
/**
 * gates — one manifest for the complete verification suite, with two output modes:
 *
 *   - default: one compact JSON object for CI and automated consumption
 *   - `--verbose --fail-fast`: human output for `bun run verify`
 *
 * The JSON mode emits { ok, ms, failures, gates: { <gate>: { ok, ms, metrics } } }:
 *   - per-gate metrics are parsed from each tool's output (errors, coverage %,
 *     clone count, vuln count, …)
 *   - only FAILING gates carry a trimmed `error` excerpt, so a green run is tiny
 *     and a red run still contains enough to act without re-running
 *   - exits non-zero iff any gate failed → drop-in for CI / an agent check
 *
 * Pass gate names through `bun run verify` to run a subset, e.g.
 *   bun run verify typecheck lint
 */
export {};

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

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((Bun.nanoseconds() - startedAt) / 1_000_000);
}

function run(cmd: string[]): { code: number; out: string; ms: number } {
  const startedAt = Bun.nanoseconds();
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = strip(proc.stdout.toString() + proc.stderr.toString());
  return { code: proc.exitCode ?? 1, out, ms: elapsedMilliseconds(startedAt) };
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
  cmd: string[];
  parse?: (out: string) => Metrics;
}

const GATES: Gate[] = [
  {
    name: "icons",
    cmd: ["bun", "scripts/packaging/generate-icons.ts", "--check"],
  },
  {
    name: "typecheck",
    cmd: ["bun", "run", "typecheck"],
    parse: (o) => ({ errors: (o.match(/error TS\d+/g) ?? []).length }),
  },
  {
    name: "check",
    cmd: ["bun", "run", "check"],
    parse: (o): Metrics => {
      const m = o.match(/found (\d+) errors? and (\d+) warnings?/i);
      return m ? { errors: Number(m[1]), warnings: Number(m[2]) } : {};
    },
  },
  // `lint` runs `biome check` (lint + formatter + organize-imports/assist);
  // `format` is the explicit formatter-only check.
  { name: "lint", cmd: ["bun", "run", "lint"] },
  { name: "format", cmd: ["bunx", "--bun", "biome", "format", "."] },
  {
    name: "docs",
    cmd: ["bun", "run", "docs:check"],
    parse: (o): Metrics => {
      const match = o.match(
        /(\d+) Markdown files, (\d+) API operations, (\d+) environment variables/,
      );
      return match
        ? {
            markdownFiles: Number(match[1]),
            apiOperations: Number(match[2]),
            envVars: Number(match[3]),
          }
        : {};
    },
  },
  {
    name: "coverage",
    cmd: ["bun", "scripts/checks/coverage-check.ts"],
    parse: (o): Metrics => {
      // Success line: "✓ Coverage gate passed — functions 88.38% (…), lines 85.66% (…)"
      const m = o.match(/functions ([\d.]+)%.*?lines ([\d.]+)%/s);
      return m ? { funcPct: Number(m[1]), linePct: Number(m[2]) } : {};
    },
  },
  {
    name: "dup",
    cmd: ["bunx", "--bun", "jscpd"],
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
  { name: "deadcode", cmd: ["bunx", "--bun", "knip"] },
  { name: "cycles", cmd: ["bun", "scripts/checks/cycles.ts"] },
  { name: "boundaries", cmd: ["bun", "scripts/checks/boundaries.ts"] },
  {
    name: "actions",
    cmd: ["bun", "scripts/checks/workflow-actions-check.ts"],
  },
  {
    name: "provider-fixtures",
    cmd: ["bun", "scripts/checks/provider-fixtures.ts"],
  },
  {
    name: "runtime",
    cmd: ["bun", "scripts/checks/runtime-version-check.ts"],
  },
  {
    name: "mutation-config",
    cmd: ["bun", "scripts/checks/mutation-runner.ts", "--check"],
  },
  {
    name: "e2e",
    cmd: ["bun", "run", "test:e2e"],
    parse: (o): Metrics => ({
      passed: int(/(\d+) passed/, o) ?? 0,
      skipped: int(/(\d+) skipped/, o) ?? 0,
    }),
  },
  {
    name: "build",
    cmd: ["bun", "run", "build"],
    parse: (o): Metrics => {
      const m = o.match(/built in ([\d.]+)\s*s/);
      return m ? { builtInS: Number(m[1]) } : {};
    },
  },
  {
    name: "audit",
    cmd: ["bun", "audit"],
    parse: (o) => ({ vulnerabilities: int(/(\d+) vulnerabilit/i, o) ?? 0 }),
  },
];

const arguments_ = process.argv.slice(2);
const verbose = arguments_.includes("--verbose");
const failFast = arguments_.includes("--fail-fast");
const requested: string[] = [];
const excluded: string[] = [];
for (let i = 0; i < arguments_.length; i++) {
  const argument = arguments_[i]!;
  if (argument === "--except") {
    const name = arguments_[++i];
    if (!name || name.startsWith("-")) {
      console.error(JSON.stringify({ ok: false, error: "--except requires a gate name" }));
      process.exit(2);
    }
    excluded.push(name);
  } else if (!argument.startsWith("-")) requested.push(argument);
}
const unknown = [...requested, ...excluded].filter((name) => !GATES.some((g) => g.name === name));

if (unknown.length) {
  console.error(
    JSON.stringify({
      ok: false,
      error: `unknown gate(s): ${unknown.join(", ")}`,
      available: GATES.map((g) => g.name),
    }),
  );
  process.exit(2);
}
const selected = GATES.filter(
  (g) => (!requested.length || requested.includes(g.name)) && !excluded.includes(g.name),
);

const startedAt = Bun.nanoseconds();
const gates: Record<string, GateResult> = {};
const failures: string[] = [];

if (!(await Bun.file("node_modules/.bin/svelte-kit").exists())) {
  const error = "Dependencies are not installed; run `bun install --frozen-lockfile`, then retry.";
  if (verbose) console.error(error);
  console.log(
    JSON.stringify({
      ok: false,
      ms: elapsedMilliseconds(startedAt),
      failures: ["prepare"],
      gates: { prepare: { ok: false, ms: 0, error } },
    }),
  );
  process.exit(1);
}

// Prepare: generate SvelteKit's `.svelte-kit/` (the $types + $lib path aliases)
// once, up front. On a fresh checkout it doesn't exist yet, and without it both
// `bun check` (typecheck) and `bun test` ($lib import resolution) fail. Doing it here
// — not relying on gate order — keeps subset runs (e.g. `gates coverage`)
// correct too.
const sync = run(["bunx", "--bun", "svelte-kit", "sync"]);
if (sync.code !== 0) {
  if (verbose && sync.out.trim()) console.error(sync.out.trimEnd());
  console.log(
    JSON.stringify({
      ok: false,
      ms: elapsedMilliseconds(startedAt),
      failures: ["prepare"],
      gates: { prepare: { ok: false, ms: sync.ms, error: tail(sync.out) } },
    }),
  );
  process.exit(1);
}

for (const g of selected) {
  if (verbose) console.log(`\n== ${g.name} ==`);
  const { code, out, ms } = run(g.cmd);
  if (verbose && out.trim()) console.log(out.trimEnd());
  const ok = code === 0;
  const metrics = g.parse?.(out);
  gates[g.name] = {
    ok,
    ms,
    ...(metrics && Object.keys(metrics).length ? { metrics } : {}),
    ...(ok ? {} : { error: tail(out) }),
  };
  if (!ok) failures.push(g.name);
  if (!ok && failFast) break;
}

const summary = { ok: failures.length === 0, ms: elapsedMilliseconds(startedAt), failures, gates };

// Minified when green (fewest tokens); indented when red so excerpts are readable.
console.log(JSON.stringify(summary, null, failures.length ? 2 : 0));
process.exit(failures.length ? 1 : 0);
