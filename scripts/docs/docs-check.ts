#!/usr/bin/env bun
/** Validate documentation references that can be derived from the repository. */

import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const errors: string[] = [];

function location(file: string, text: string, index: number): string {
  return `${relative(ROOT, file)}:${text.slice(0, index).split("\n").length}`;
}

function outsideFences(text: string): string {
  let fence: "```" | "~~~" | null = null;
  return text
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*(```|~~~)/)?.[1] as "```" | "~~~" | undefined;
      if (marker && fence === null) {
        fence = marker;
        return "";
      }
      if (marker === fence) {
        fence = null;
        return "";
      }
      return fence === null ? line : "";
    })
    .join("\n");
}

function markdownAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of outsideFences(text).split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading) continue;
    const base = heading
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

const markdownPaths = new Set<string>();
for (const pattern of ["*.md", "docs/**/*.md", "plans/**/*.md"]) {
  for await (const file of new Bun.Glob(pattern).scan({ cwd: ROOT, onlyFiles: true })) {
    markdownPaths.add(file);
  }
}
const markdownFiles = [...markdownPaths].sort().map((file) => resolve(ROOT, file));
const markdown = new Map(
  await Promise.all(
    markdownFiles.map(async (file) => [file, await Bun.file(file).text()] as const),
  ),
);
const anchorCache = new Map<string, Set<string>>();

function checkMarkdownTarget(sourceFile: string, source: string, rawTarget: string, index: number) {
  const target = rawTarget.replace(/^<|>$/g, "");
  if (/^(?:[a-z]+:|\/)/i.test(target)) return;
  const [pathWithQuery = "", rawFragment] = target.split("#", 2);
  const pathPart = pathWithQuery.split("?", 1)[0] ?? "";
  let decodedPath: string;
  let fragment: string | undefined;
  try {
    decodedPath = decodeURIComponent(pathPart);
    fragment = rawFragment === undefined ? undefined : decodeURIComponent(rawFragment);
  } catch {
    errors.push(`${location(sourceFile, source, index)} invalid encoded link: ${target}`);
    return;
  }
  const destination = decodedPath ? resolve(dirname(sourceFile), decodedPath) : sourceFile;
  const repoRelative = relative(ROOT, destination);
  if (repoRelative.startsWith("..")) {
    errors.push(`${location(sourceFile, source, index)} link leaves repository: ${target}`);
    return;
  }
  if (!existsSync(destination)) {
    errors.push(`${location(sourceFile, source, index)} missing link target: ${target}`);
    return;
  }
  if (fragment !== undefined && (decodedPath === "" || destination.endsWith(".md"))) {
    const destinationText = markdown.get(destination);
    if (destinationText === undefined) {
      errors.push(`${location(sourceFile, source, index)} anchor target is not checked: ${target}`);
      return;
    }
    const anchors = anchorCache.get(destination) ?? markdownAnchors(destinationText);
    anchorCache.set(destination, anchors);
    if (!anchors.has(fragment)) {
      errors.push(`${location(sourceFile, source, index)} missing Markdown anchor: ${target}`);
    }
  }
}

for (const [file, text] of markdown) {
  const visibleText = outsideFences(text);
  for (const match of visibleText.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    checkMarkdownTarget(file, text, match[1] ?? "", match.index);
  }
  for (const match of visibleText.matchAll(/^\s*\[[^\]]+]:\s*(\S+)/gm)) {
    checkMarkdownTarget(file, text, match[1] ?? "", match.index);
  }
}

const packageJson = (await Bun.file(resolve(ROOT, "package.json")).json()) as {
  scripts?: Record<string, string>;
};
const packageScripts = packageJson.scripts ?? {};
for (const [file, text] of markdown) {
  for (const match of text.matchAll(/\bbun run ([A-Za-z0-9:_-]+)\b/g)) {
    const script = match[1] ?? "";
    if (!(script in packageScripts)) {
      errors.push(`${location(file, text, match.index)} missing package script: bun run ${script}`);
    }
  }
}

const apiDocPath = resolve(ROOT, "docs/api.md");
const apiDoc = await Bun.file(apiDocPath).text();
const documentedApi = new Set<string>();
for (const match of apiDoc.matchAll(
  /^\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`(\/api\/[^`]+)`\s*\|/gm,
)) {
  const method = match[1] ?? "";
  const endpoint = (match[2] ?? "").split("?", 1)[0]?.replace(/\/$/, "") ?? "";
  const routePath = endpoint.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "[$1]");
  const routeFile = resolve(ROOT, `src/routes${routePath}/+server.ts`);
  documentedApi.add(`${method} ${endpoint}`);
  if (!existsSync(routeFile)) {
    errors.push(
      `${location(apiDocPath, apiDoc, match.index)} missing API route: ${method} ${endpoint}`,
    );
    continue;
  }
  const routeSource = await Bun.file(routeFile).text();
  if (!new RegExp(`export\\s+(?:const|function)\\s+${method}\\b`).test(routeSource)) {
    errors.push(
      `${location(apiDocPath, apiDoc, match.index)} route does not export ${method}: ${endpoint}`,
    );
  }
}

const routeFiles = await Array.fromAsync(
  new Bun.Glob("src/routes/api/**/+server.ts").scan({ cwd: ROOT, onlyFiles: true }),
);
const implementedApi = new Set<string>();
for (const routeFile of routeFiles) {
  const routeSource = await Bun.file(resolve(ROOT, routeFile)).text();
  const endpoint = `/${routeFile
    .replace(/^src\/routes\//, "")
    .replace(/\/\+server\.ts$/, "")
    .replace(/\[([A-Za-z][A-Za-z0-9_]*)]/g, ":$1")}`;
  for (const match of routeSource.matchAll(
    /export\s+(?:const|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
  )) {
    implementedApi.add(`${match[1]} ${endpoint}`);
  }
}
for (const operation of implementedApi) {
  if (!documentedApi.has(operation)) errors.push(`docs/api.md missing API operation: ${operation}`);
}

const configPath = resolve(ROOT, "docs/configuration.md");
const configDoc = await Bun.file(configPath).text();
const documentedEnv = new Set(
  Array.from(configDoc.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm), (match) => match[1] ?? ""),
);
const sourceEnv = new Set<string>();
for (const pattern of ["src/**/*.ts", "src/**/*.svelte"]) {
  for await (const sourceFile of new Bun.Glob(pattern).scan({ cwd: ROOT, onlyFiles: true })) {
    if (sourceFile.includes(".test.") || sourceFile.endsWith("test-setup.ts")) continue;
    const source = await Bun.file(resolve(ROOT, sourceFile)).text();
    for (const match of source.matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]*)/g)) {
      sourceEnv.add(match[1] ?? "");
    }
  }
}
const externallyOwnedEnv = new Set([
  "ADDRESS_HEADER",
  "GH_MIGRATE_PUBLISH_HOST",
  "ORIGIN",
  "PORT",
  "XFF_DEPTH",
]);
for (const name of sourceEnv) {
  if (!documentedEnv.has(name))
    errors.push(`docs/configuration.md missing environment variable: ${name}`);
}
for (const name of documentedEnv) {
  if (!sourceEnv.has(name) && !externallyOwnedEnv.has(name)) {
    errors.push(`docs/configuration.md documents unused environment variable: ${name}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  `Documentation check passed: ${markdown.size} Markdown files, ${implementedApi.size} API operations, ${documentedEnv.size} environment variables`,
);
