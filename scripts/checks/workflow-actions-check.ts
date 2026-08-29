#!/usr/bin/env bun
/** Require immutable commit SHAs for every external GitHub Actions reference. */

import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const errors: string[] = [];

for await (const workflow of new Bun.Glob(".github/workflows/*.{yml,yaml}").scan({
  cwd: ROOT,
  onlyFiles: true,
})) {
  const path = resolve(ROOT, workflow);
  const source = await Bun.file(path).text();
  for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
    const reference = match[1] ?? "";
    if (reference.startsWith("./")) continue;
    const separator = reference.lastIndexOf("@");
    const revision = separator >= 0 ? reference.slice(separator + 1) : "";
    if (!/^[0-9a-f]{40}$/i.test(revision)) {
      const line = source.slice(0, match.index).split("\n").length;
      errors.push(`${relative(ROOT, path)}:${line} external action must use a 40-character SHA`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("[actions] All external workflow actions are pinned to commit SHAs");
