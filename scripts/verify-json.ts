#!/usr/bin/env bun
/**
 * verify:json — run the full gate suite and emit a compact JSON summary instead
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
 * Runs the exact commands behind the `verify` script, so a pass here means the
 * same as a `verify` pass. Pass gate names as args to run a subset, e.g.
 *   bun run verify:json typecheck lint
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

function run(cmd: string[]): { code: number; out: string; ms: number } {
  const t0 = Date.now();
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = strip(proc.stdout.toString() + proc.stderr.toString());
  return { code: proc.exitCode ?? 1, out, ms: Date.now() - t0 };
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
    name: "typecheck",
    cmd: ["bun", "run", "typecheck"],
    parse: (o) => ({ errors: (o.match(/error TS\d+/g) ?? []).length }),
  },
  {
    name: "check",
    cmd: ["bun", "run", "check"],
    parse: (o) => {
      const m = o.match(/found (\d+) errors? and (\d+) warnings?/i);
      return m ? { errors: Number(m[1]), warnings: Number(m[2]) } : {};
    },
  },
  { name: "lint", cmd: ["bun", "run", "lint"] },
  { name: "format", cmd: ["bun", "run", "format:check"] },
  {
    name: "coverage",
    cmd: ["bun", "run", "coverage:check"],
    parse: (o) => {
      // Success line: "✓ Coverage gate passed — functions 88.38% (…), lines 85.66% (…)"
      const m = o.match(/functions ([\d.]+)%.*?lines ([\d.]+)%/s);
      return m ? { funcPct: Number(m[1]), linePct: Number(m[2]) } : {};
    },
  },
  {
    name: "dup",
    cmd: ["bun", "run", "dup"],
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
  { name: "deadcode", cmd: ["bun", "run", "deadcode"] },
  { name: "cycles", cmd: ["bun", "run", "cycles"] },
  {
    name: "build",
    cmd: ["bun", "run", "build"],
    parse: (o) => {
      const m = o.match(/built in ([\d.]+)\s*s/);
      return m ? { builtInS: Number(m[1]) } : {};
    },
  },
  {
    name: "audit",
    cmd: ["bun", "run", "audit"],
    parse: (o) => ({ vulnerabilities: int(/(\d+) vulnerabilit/i, o) ?? 0 }),
  },
];

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

for (const g of selected) {
  const { code, out, ms } = run(g.cmd);
  const ok = code === 0;
  const metrics = g.parse?.(out);
  gates[g.name] = {
    ok,
    ms,
    ...(metrics && Object.keys(metrics).length ? { metrics } : {}),
    ...(ok ? {} : { error: tail(out) }),
  };
  if (!ok) failures.push(g.name);
}

const summary = { ok: failures.length === 0, ms: Date.now() - t0, failures, gates };

// Minified when green (fewest tokens); indented when red so excerpts are readable.
console.log(JSON.stringify(summary, null, failures.length ? 2 : 0));
process.exit(failures.length ? 1 : 0);
