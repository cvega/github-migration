export {};

const CLIENT_OUTPUT = ".svelte-kit/output/client";
const ICON_CHUNK_MARKER = "M6.766 11.328";
const MAX_ICON_CHUNK_BYTES = 120_000;
const MAX_ICON_CHUNK_GZIP_BYTES = 35_000;

const chunks: Array<{ path: string; bytes: ArrayBuffer }> = [];
const glob = new Bun.Glob("_app/immutable/**/*.js");
for await (const path of glob.scan({ cwd: CLIENT_OUTPUT, onlyFiles: true })) {
  const file = Bun.file(`${CLIENT_OUTPUT}/${path}`);
  const bytes = await file.arrayBuffer();
  if (new TextDecoder().decode(bytes).includes(ICON_CHUNK_MARKER)) chunks.push({ path, bytes });
}

if (chunks.length !== 1) {
  throw new Error(`Expected one generated icon chunk, found ${chunks.length}`);
}

const [chunk] = chunks;
if (!chunk) throw new Error("Generated icon chunk was not found");
const gzipBytes = Bun.gzipSync(chunk.bytes).byteLength;
if (chunk.bytes.byteLength > MAX_ICON_CHUNK_BYTES || gzipBytes > MAX_ICON_CHUNK_GZIP_BYTES) {
  throw new Error(
    `Icon chunk exceeds budget: ${chunk.bytes.byteLength} raw / ${gzipBytes} gzip bytes`,
  );
}

console.log(
  `[bundle] icon chunk ${chunk.path}: ${chunk.bytes.byteLength} raw / ${gzipBytes} gzip bytes`,
);
