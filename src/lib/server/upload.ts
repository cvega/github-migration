/**
 * Archive upload to GitHub-managed storage (uploads.github.com).
 * Supports single-part and multipart uploads.
 *
 * Accepts `Blob` (including `BunFile` from `Bun.file()`) or `Uint8Array`
 * so callers can stream from disk without buffering the entire archive
 * into memory.
 */

const MULTIPART_CUTOFF = 100 * 1024 * 1024; // 100 MiB
const UPLOAD_MAX_RETRIES = 3;
const UPLOAD_RETRY_DELAY_MS = 5_000;

/** Normalise to Blob so fetch always gets a valid BodyInit. */
function toBlob(data: Blob | Uint8Array): Blob {
  return data instanceof Blob ? data : new Blob([data as BlobPart]);
}

/**
 * Retry wrapper — retries a function up to `maxRetries` times with a
 * linear backoff delay for transient network / server errors.
 * Accepts an optional AbortSignal to bail out of retries on cancellation.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = UPLOAD_MAX_RETRIES,
  delayMs = UPLOAD_RETRY_DELAY_MS,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw new Error("Aborted");
      if (attempt < maxRetries) {
        const wait = delayMs * (attempt + 1);
        console.warn(
          `[upload] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${wait}ms:`,
          err instanceof Error ? err.message : err,
        );
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, wait);
          function onAbort() {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }
  throw lastError;
}

export async function uploadArchive(
  archive: Blob | Uint8Array,
  name: string,
  orgDatabaseId: string,
  targetToken: string,
  uploadsUrl = "https://uploads.github.com",
  signal?: AbortSignal,
): Promise<string> {
  return withRetry(
    async () => {
      const size = archive instanceof Blob ? archive.size : archive.byteLength;
      if (size > MULTIPART_CUTOFF) {
        return uploadMultipart(archive, size, name, orgDatabaseId, targetToken, uploadsUrl);
      }
      return uploadSingle(archive, size, name, orgDatabaseId, targetToken, uploadsUrl);
    },
    `upload ${name}`,
    UPLOAD_MAX_RETRIES,
    UPLOAD_RETRY_DELAY_MS,
    signal,
  );
}

async function uploadSingle(
  archive: Blob | Uint8Array,
  size: number,
  name: string,
  orgDatabaseId: string,
  token: string,
  uploadsUrl: string,
): Promise<string> {
  const url = `${uploadsUrl}/organizations/${orgDatabaseId}/gei/archive?name=${name}`;
  console.log(`Uploading archive (single): ${name} (${(size / 1024 / 1024).toFixed(1)} MiB)`);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: toBlob(archive),
  });

  if (!resp.ok) throw new Error(`Upload failed: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as { uri: string };
  console.log(`Archive uploaded: ${data.uri}`);
  return data.uri;
}

async function uploadMultipart(
  archive: Blob | Uint8Array,
  totalSize: number,
  name: string,
  orgDatabaseId: string,
  token: string,
  uploadsUrl: string,
): Promise<string> {
  const partSize = MULTIPART_CUTOFF;
  const totalParts = Math.ceil(totalSize / partSize);

  console.log(`Starting multipart upload: ${name} (${totalParts} parts)`);

  // Step 1: Start
  const startUrl = `${uploadsUrl}/organizations/${orgDatabaseId}/gei/archive/blobs/uploads`;
  const startResp = await fetch(startUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content_type: "application/octet-stream",
      name,
      size: totalSize,
    }),
  });

  if (!startResp.ok) throw new Error(`Multipart start failed: ${startResp.status}`);
  let nextUrl = resolveUrl(uploadsUrl, startResp.headers.get("location") || "");

  // Step 2: Upload parts
  for (let part = 0; part < totalParts; part++) {
    const start = part * partSize;
    const end = Math.min(start + partSize, totalSize);

    // Slice from the source — Blob.slice() is lazy (no copy),
    // Uint8Array.slice() copies but only one chunk at a time.
    const chunk = archive.slice(start, end);

    console.log(`Uploading part ${part + 1}/${totalParts}`);

    const partResp = await fetch(nextUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: toBlob(chunk),
    });

    if (!partResp.ok) throw new Error(`Part ${part + 1} upload failed: ${partResp.status}`);
    nextUrl = resolveUrl(uploadsUrl, partResp.headers.get("location") || "");
  }

  // Step 3: Complete
  const completeResp = await fetch(nextUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!completeResp.ok) throw new Error(`Multipart complete failed: ${completeResp.status}`);
  const data = (await completeResp.json()) as { uri: string };
  console.log(`Multipart upload complete: ${data.uri}`);
  return data.uri;
}

function resolveUrl(base: string, location: string): string {
  if (location.startsWith("/")) return base + location;
  return location;
}
