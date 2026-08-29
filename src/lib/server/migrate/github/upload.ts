const MULTIPART_CUTOFF = 100 * 1024 * 1024;
const UPLOAD_MAX_RETRIES = 3;
const UPLOAD_RETRY_DELAY_MS = 5_000;
const UPLOAD_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;

class NonRetryableUploadError extends Error {}

function toBlob(data: Blob | Uint8Array): Blob {
  return data instanceof Blob ? data : new Blob([data as BlobPart]);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(UPLOAD_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  maxRetries = UPLOAD_MAX_RETRIES,
  delayMs = UPLOAD_RETRY_DELAY_MS,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw new Error("Aborted");
      if (error instanceof NonRetryableUploadError) throw error;
      if (attempt < maxRetries) {
        const wait = delayMs * (attempt + 1);
        console.warn(
          `[upload] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${wait}ms:`,
          error instanceof Error ? error.message : error,
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
        return uploadMultipart(archive, size, name, orgDatabaseId, targetToken, uploadsUrl, signal);
      }
      return uploadSingle(archive, size, name, orgDatabaseId, targetToken, uploadsUrl, signal);
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
  signal?: AbortSignal,
): Promise<string> {
  const url = `${uploadsUrl}/organizations/${orgDatabaseId}/gei/archive?name=${encodeURIComponent(name)}`;
  console.log(`Uploading archive (single): ${name} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: toBlob(archive),
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { uri: string };
  return data.uri;
}

async function uploadMultipart(
  archive: Blob | Uint8Array,
  totalSize: number,
  name: string,
  orgDatabaseId: string,
  token: string,
  uploadsUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const partSize = MULTIPART_CUTOFF;
  const totalParts = Math.ceil(totalSize / partSize);
  const startUrl = `${uploadsUrl}/organizations/${orgDatabaseId}/gei/archive/blobs/uploads`;
  const startResponse = await fetch(startUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: "application/octet-stream", name, size: totalSize }),
    signal: requestSignal(signal),
  });
  if (!startResponse.ok) throw new Error(`Multipart start failed: ${startResponse.status}`);
  let nextUrl = resolveUrl(uploadsUrl, startResponse.headers.get("location") || "");

  for (let part = 0; part < totalParts; part += 1) {
    const start = part * partSize;
    const end = Math.min(start + partSize, totalSize);
    const response = await fetch(nextUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: toBlob(archive.slice(start, end)),
      signal: requestSignal(signal),
    });
    if (!response.ok) throw new Error(`Part ${part + 1} upload failed: ${response.status}`);
    nextUrl = resolveUrl(uploadsUrl, response.headers.get("location") || "");
  }

  const completeResponse = await fetch(nextUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    signal: requestSignal(signal),
  });
  if (!completeResponse.ok) {
    throw new Error(`Multipart complete failed: ${completeResponse.status}`);
  }
  const data = (await completeResponse.json()) as { uri: string };
  return data.uri;
}

function resolveUrl(base: string, location: string): string {
  if (!location) {
    throw new NonRetryableUploadError("Multipart upload response omitted its continuation URL");
  }
  const baseUrl = new URL(base);
  const resolved = new URL(location, `${baseUrl.origin}/`);
  if (resolved.origin !== baseUrl.origin) {
    throw new NonRetryableUploadError("Multipart upload continuation URL changed origin");
  }
  return resolved.toString();
}
