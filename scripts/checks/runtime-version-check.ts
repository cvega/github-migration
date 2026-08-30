#!/usr/bin/env bun
/** Keep the production image and CI on the Bun version declared by the package. */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const packageJson = (await Bun.file(resolve(ROOT, "package.json")).json()) as {
  packageManager?: unknown;
};
const packageManager =
  typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
const version = packageManager.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1];
if (!version) {
  throw new Error('package.json packageManager must be an exact version such as "bun@1.4.0"');
}

const dockerfile = await Bun.file(resolve(ROOT, "Dockerfile")).text();
const imageReferences = Array.from(
  dockerfile.matchAll(/^FROM oven\/bun:([^\s@-]+)-alpine@sha256:([a-f0-9]{64})(?:\s|$)/gm),
  (match) => ({ version: match[1] ?? "", digest: match[2] ?? "" }),
);
const bunStageCount = dockerfile.match(/^FROM oven\/bun:/gm)?.length ?? 0;
if (
  imageReferences.length === 0 ||
  imageReferences.length !== bunStageCount ||
  imageReferences.some((reference) => reference.version !== version)
) {
  throw new Error(`Every oven/bun Docker stage must use ${version}-alpine pinned by digest`);
}
if (new Set(imageReferences.map((reference) => reference.digest)).size !== 1) {
  throw new Error("Every oven/bun Docker stage must use the same image digest");
}

for await (const workflow of new Bun.Glob(".github/workflows/*.{yml,yaml}").scan({
  cwd: ROOT,
  onlyFiles: true,
})) {
  const source = await Bun.file(resolve(ROOT, workflow)).text();
  const setupCount = source.match(/^\s*(?:-\s*)?uses:\s*oven-sh\/setup-bun@/gm)?.length ?? 0;
  const packageVersionCount =
    source.match(/^\s*bun-version-file:\s*["']?package\.json["']?\s*$/gm)?.length ?? 0;
  if (setupCount !== packageVersionCount) {
    throw new Error(`${workflow} must configure every setup-bun step from package.json`);
  }
}

console.log(`[runtime] CI and Docker use Bun ${version}`);
