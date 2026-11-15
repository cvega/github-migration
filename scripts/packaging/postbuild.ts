/**
 * Post-build script — patches adapter-node's static asset map to add
 * Cache-Control headers for fonts, images, and favicon.
 *
 * Immutable assets already get `max-age=31536000,immutable`.
 * Everything else in client/ (fonts, images, etc.) gets 7-day caching.
 */
export {};

const target = "build/server/adapter-node-handler.js";
const src = await Bun.file(target).text();

const policy =
  /if \(key\.startsWith\(immutable\)\)\s*(?:\/\*\*[^*]*\*\/\s*)?asset\.cache_control = "public,max-age=31536000,immutable";/g;

if ([...src.matchAll(policy)].length !== 1) {
  console.error("[postbuild] ✗ Expected exactly one cache-control patch target in", target);
  process.exit(1);
}

const patched = src.replace(
  policy,
  'asset.cache_control = key.startsWith(immutable) ? "public,max-age=31536000,immutable" : "public,max-age=604800";',
);

await Bun.write(target, patched);
console.log("[postbuild] ✓ Patched static asset Cache-Control headers");
