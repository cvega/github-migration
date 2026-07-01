import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Post-build script — patches build/handler.js to add Cache-Control
 * headers for static assets (fonts, images, favicon) that sirv serves
 * without any caching by default.
 *
 * Immutable assets already get `max-age=31536000,immutable`.
 * Everything else in client/ (fonts, images, etc.) gets 7-day caching.
 */
export {};

const HANDLER = "build/handler.js";
const CHUNK_DIR = "build/server/chunks";
const candidates = [
  HANDLER,
  ...(existsSync(CHUNK_DIR)
    ? readdirSync(CHUNK_DIR)
        .filter((name) => /^handler-.*\.js$/.test(name))
        .map((name) => join(CHUNK_DIR, name))
    : []),
];

// Match the closing brace of the immutable cache-control block.
// The handler sets cache-control only for /_app/immutable/ paths;
// we add an else-if for all other 200 responses from the static dir.
for (const handler of candidates) {
  const src = await Bun.file(handler).text();
  const patched = src.replace(
    /(res\.setHeader\('cache-control',\s*'public,max-age=31536000,immutable'\);[\s\n\r]*\})/,
    `$1 else if (res.statusCode === 200) {\n\t\t\t\t\t\t\t\tres.setHeader('cache-control', 'public,max-age=604800');\n\t\t\t\t\t\t\t}`,
  );

  if (patched === src) continue;

  await Bun.write(handler, patched);
  console.log("[postbuild] ✓ Patched static asset Cache-Control headers in", handler);
  process.exit(0);
}

console.error("[postbuild] ✗ Could not find cache-control patch target in", candidates);
process.exit(1);
