#!/usr/bin/env bun
/**
 * Architecture boundary check — enforces the server layering so the structure
 * can't quietly erode as new domains are added:
 *
 *   - `core/` is primitive: it must not import a domain (migrate, profile) or
 *     the composition root (registry).
 *   - a domain must not import another domain — siblings stay decoupled and
 *     talk only through `core`.
 *   - `registry.ts` is the composition root and may import every domain.
 *
 * Both absolute (`$lib/server/<x>`) and relative (`../<x>/…`) imports are
 * resolved to a layer, so neither import style can sneak a violation past the
 * check. Wired into `verify`; exits non-zero (and prints each violation) on a
 * breach.
 */
import { dirname, relative, resolve } from "node:path";
import { Glob } from "bun";

const SERVER_DIR = resolve("src/lib/server");
type Layer = "core" | "migrate" | "profile" | "registry" | "root";

/** Map a file under src/lib/server to its layer. */
function layerOfFile(absFile: string): Layer {
  const rel = relative(SERVER_DIR, absFile);
  const top = rel.split("/")[0] ?? "";
  if (top === "core") return "core";
  if (top === "migrate" || top === "profile") return top;
  if (top === "registry.ts") return "registry";
  return "root";
}

/** Resolve an import specifier to the server layer it targets, or null. */
function targetLayer(spec: string, fromFile: string): Layer | null {
  let abs: string;
  if (spec.startsWith("$lib/server/")) {
    abs = resolve(SERVER_DIR, spec.slice("$lib/server/".length));
  } else if (spec.startsWith(".")) {
    abs = resolve(dirname(fromFile), spec);
  } else {
    return null; // external package, $lib/types, $app, $env, etc.
  }
  const rel = relative(SERVER_DIR, abs);
  if (rel.startsWith("..")) return null; // outside server/
  const top = rel.split("/")[0] ?? "";
  if (top === "core") return "core";
  if (top === "migrate" || top === "profile") return top;
  if (top === "registry" || top === "registry.ts") return "registry";
  return "root";
}

const IMPORT_RE = /\bfrom\s*['"]([^'"]+)['"]/;
const DYN_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

interface Violation {
  file: string;
  line: number;
  spec: string;
  reason: string;
}

function check(from: Layer, to: Layer | null): string | null {
  if (to === null) return null;
  if (from === "core" && (to === "migrate" || to === "profile")) {
    return "core/ must not import a domain";
  }
  if (from === "core" && to === "registry") {
    return "core/ must not import the registry (composition root)";
  }
  if ((from === "migrate" || from === "profile") && (to === "migrate" || to === "profile") && to !== from) {
    return `domain '${from}' must not import domain '${to}'`;
  }
  return null;
}

const violations: Violation[] = [];

for await (const file of new Glob("src/lib/server/**/*.ts").scan(".")) {
  const absFile = resolve(file);
  const from = layerOfFile(absFile);
  const lines = (await Bun.file(file).text()).split("\n");
  lines.forEach((text, i) => {
    const specs: string[] = [];
    const m = text.match(IMPORT_RE);
    if (m?.[1]) specs.push(m[1]);
    for (const dm of text.matchAll(DYN_IMPORT_RE)) if (dm[1]) specs.push(dm[1]);
    for (const spec of specs) {
      const reason = check(from, targetLayer(spec, absFile));
      if (reason) violations.push({ file, line: i + 1, spec, reason });
    }
  });
}

if (violations.length > 0) {
  console.error(`✗ Boundary check: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  imports "${v.spec}"\n    → ${v.reason}`);
  }
  process.exit(1);
}

console.log("✓ Boundary check passed — core/ stays primitive and domains stay decoupled");
