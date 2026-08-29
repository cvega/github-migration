#!/usr/bin/env bun
/** Check the complete project dependency graph while accounting for virtual modules. */

import { createRequire } from "node:module";
import { resolve } from "node:path";

interface MadgeResult {
  circular(): string[][];
  obj(): Record<string, string[]>;
  warnings(): { skipped: string[] };
}

type Madge = (
  path: string,
  config: { fileExtensions: string[]; tsConfig: string },
) => Promise<MadgeResult>;

const require = createRequire(import.meta.url);
const madge = require("madge") as Madge;
const ROOT = resolve(import.meta.dir, "../..");

function isVirtualModule(specifier: string): boolean {
  return (
    specifier.startsWith("$app/") ||
    specifier.startsWith("$env/") ||
    specifier.startsWith("bun:") ||
    specifier === "./$types"
  );
}

const result = await madge(resolve(ROOT, "src"), {
  fileExtensions: ["ts", "svelte"],
  tsConfig: resolve(ROOT, "tsconfig.madge.json"),
});
const skipped = [...new Set(result.warnings().skipped)].sort();
const unresolved = skipped.filter((specifier) => !isVirtualModule(specifier));
const cycles = result.circular();

if (unresolved.length > 0) {
  console.error("Unresolved project dependencies:");
  for (const specifier of unresolved) console.error(`  ${specifier}`);
}

if (cycles.length > 0) {
  console.error("Circular dependencies:");
  for (const cycle of cycles) console.error(`  ${cycle.join(" -> ")}`);
}

if (unresolved.length > 0 || cycles.length > 0) process.exit(1);

const fileCount = Object.keys(result.obj()).length;
console.log(
  `[cycles] ${fileCount} files checked; no cycles or unresolved project dependencies (${skipped.length} virtual modules excluded)`,
);
