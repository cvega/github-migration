#!/usr/bin/env bun
/**
 * Architecture boundary check — enforces the server layering so the structure
 * can't quietly erode as new domains are added:
 *
 *   - `core/` is primitive: it must not import a domain or the composition root.
 *   - a domain must not import another domain — siblings stay decoupled and
 *     talk only through `core`.
 *   - `schemas.ts` is the composition root and may import every domain.
 *   - browser-capable modules must not import `$lib/server`.
 *
 * Both absolute (`$lib/server/<x>`) and relative (`../<x>/…`) imports are
 * resolved to a layer, so neither import style can sneak a violation past the
 * check. Wired into `verify`; exits non-zero (and prints each violation) on a
 * breach.
 */
import { dirname, relative, resolve } from "node:path";
import { Glob } from "bun";

const SERVER_DIR = resolve("src/lib/server");
const DOMAIN_NAMES = ["migrate", "profile", "source"] as const;
type Domain = (typeof DOMAIN_NAMES)[number];
type Layer = "core" | Domain | "schemas" | "root";

function isDomain(value: string): value is Domain {
  return DOMAIN_NAMES.some((domain) => domain === value);
}

/** Map a file under src/lib/server to its layer. */
function layerOfFile(absFile: string): Layer {
  const rel = relative(SERVER_DIR, absFile);
  const top = rel.split("/")[0] ?? "";
  if (top === "core") return "core";
  if (isDomain(top)) return top;
  if (top === "schemas.ts") return "schemas";
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
  if (isDomain(top)) return top;
  if (top === "schemas" || top === "schemas.ts") return "schemas";
  return "root";
}

const IMPORT_RE = /\b(?:from\s*|import\s*)['"]([^'"]+)['"]/g;
const DYN_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

interface Violation {
  file: string;
  line: number;
  spec: string;
  reason: string;
}

function check(from: Layer, to: Layer | null): string | null {
  if (to === null) return null;
  if (from === "core" && isDomain(to)) {
    return "core/ must not import a domain";
  }
  if (from === "core" && to === "schemas") {
    return "core/ must not import schemas.ts (composition root)";
  }
  if (isDomain(from) && isDomain(to) && to !== from) {
    return `domain '${from}' must not import domain '${to}'`;
  }
  if (isDomain(from) && to === "schemas") {
    return `domain '${from}' must not import schemas.ts (composition root)`;
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
    for (const match of text.matchAll(IMPORT_RE)) if (match[1]) specs.push(match[1]);
    for (const dm of text.matchAll(DYN_IMPORT_RE)) if (dm[1]) specs.push(dm[1]);
    for (const spec of specs) {
      const reason = check(from, targetLayer(spec, absFile));
      if (reason) violations.push({ file, line: i + 1, spec, reason });
    }
  });
}

function isBrowserCapable(file: string): boolean {
  if (file.endsWith(".svelte")) return true;
  if (!file.endsWith(".ts") || file.includes(".test.") || file.includes(".spec.")) return false;
  if (file.startsWith("src/lib/") && !file.startsWith("src/lib/server/")) return true;
  if (!file.startsWith("src/routes/")) return false;
  return !file.endsWith(".server.ts") && !file.endsWith("/+server.ts");
}

for await (const file of new Glob("src/**/*.{ts,svelte}").scan(".")) {
  if (!isBrowserCapable(file)) continue;
  const lines = (await Bun.file(file).text()).split("\n");
  lines.forEach((text, index) => {
    const specs = [
      ...Array.from(text.matchAll(IMPORT_RE), (match) => match[1]),
      ...Array.from(text.matchAll(DYN_IMPORT_RE), (match) => match[1]),
    ];
    for (const spec of specs) {
      if (spec?.startsWith("$lib/server")) {
        violations.push({
          file,
          line: index + 1,
          spec,
          reason: "browser-capable modules must not import $lib/server",
        });
      }
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

console.log("✓ Boundary check passed — server domains and browser imports stay isolated");
