#!/usr/bin/env bun
/**
 * Coverage gate.
 *
 * Bun 1.3.x *reports* coverage but does not enforce `coverageThreshold` in
 * bunfig.toml, so this script provides the real teeth: it runs the suite with
 * coverage, parses the `All files` summary row, and exits non-zero if function
 * or line coverage falls below the floors below — or if the summary can't be
 * parsed at all (fail-closed, so a future Bun output change fails loudly
 * instead of silently passing).
 *
 * Floors are intentionally a notch below current actuals so normal churn
 * doesn't trip the gate; ratchet them up as coverage climbs.
 *
 * Upgrade path: if text parsing ever becomes brittle, switch to an lcov
 * reporter (`bun test --coverage --coverage-reporter=lcov`) and parse
 * coverage/lcov.info instead.
 */

const MIN_FUNC_PCT = 85;
const MIN_LINE_PCT = 82;

const proc = Bun.spawnSync(["bun", "test", "--coverage"], {
  stdout: "pipe",
  stderr: "pipe",
});

const raw = proc.stdout.toString() + proc.stderr.toString();
// Strip ANSI color codes (ESC[…m) so parsing is robust even if a TTY sneaks in.
// Built from charCode 27 to avoid a literal control character in source.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const output = raw.replace(ansi, "");

// Surface a failing test run first — coverage is meaningless if tests fail.
if (proc.exitCode !== 0) {
  process.stdout.write(output);
  console.error(`\n✗ Coverage gate: test run failed (exit ${proc.exitCode}).`);
  process.exit(proc.exitCode || 1);
}

// Parse the summary row: "All files | <% Funcs> | <% Lines> | <uncovered>".
const row = output.split("\n").find((line) => line.trimStart().startsWith("All files"));
if (!row) {
  process.stdout.write(output);
  console.error("✗ Coverage gate: could not find the 'All files' summary row.");
  process.exit(1);
}

const cells = row.split("|").map((cell) => cell.trim());
// Missing cells (a future output change) parse to NaN, caught by the guard below.
const funcPct = Number.parseFloat(cells[1] ?? "");
const linePct = Number.parseFloat(cells[2] ?? "");

if (!Number.isFinite(funcPct) || !Number.isFinite(linePct)) {
  console.error(`✗ Coverage gate: could not parse percentages from row: ${row.trim()}`);
  process.exit(1);
}

const failures: string[] = [];
if (funcPct < MIN_FUNC_PCT) failures.push(`functions ${funcPct.toFixed(2)}% < ${MIN_FUNC_PCT}%`);
if (linePct < MIN_LINE_PCT) failures.push(`lines ${linePct.toFixed(2)}% < ${MIN_LINE_PCT}%`);

if (failures.length > 0) {
  console.error(`✗ Coverage below floor: ${failures.join(", ")}`);
  process.exit(1);
}

console.log(
  `✓ Coverage gate passed — functions ${funcPct.toFixed(2)}% (≥ ${MIN_FUNC_PCT}%), ` +
    `lines ${linePct.toFixed(2)}% (≥ ${MIN_LINE_PCT}%)`,
);
