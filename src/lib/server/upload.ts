/**
 * Archive upload to GitHub-managed storage (uploads.github.com).
 * Supports single-part and multipart uploads.
 */

const MULTIPART_CUTOFF = 100 * 1024 * 1024; // 100 MiB

export async function uploadArchive(
  archive: Uint8Array,
  name: string,
  orgDatabaseId: string,
  targetToken: string,
  uploadsUrl = "https://uploads.github.com",
): Promise<string> {
  if (archive.byteLength > MULTIPART_CUTOFF) {
    return uploadMultipart(
      archive,
      name,
      orgDatabaseId,
      targetToken,
      uploadsUrl,
    );
  }
  return uploadSingle(archive, name, orgDatabaseId, targetToken, uploadsUrl);
}

async function uploadSingle(
  archive: Uint8Array,
  name: string,
  orgDatabaseId: string,
  token: string,
  uploadsUrl: string,
): Promise<string> {
  const url = `${uploadsUrl}/organizations/${orgDatabaseId}/gei/archive?name=${name}`;
  console.log(
    `Uploading archive (single): ${name} (${(archive.length / 1024 / 1024).toFixed(1)} MiB)`,
  );

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: archive.buffer as ArrayBuffer,
  });

  if (!resp.ok)
    throw new Error(`Upload failed: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as { uri: string };
  console.log(`Archive uploaded: ${data.uri}`);
  return data.uri;
}

async function uploadMultipart(
  archive: Uint8Array,
  name: string,
  orgDatabaseId: string,
  token: string,
  uploadsUrl: string,
): Promise<string> {
  const partSize = MULTIPART_CUTOFF;
  const totalParts = Math.ceil(archive.length / partSize);

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
      size: archive.length,
    }),
  });

  if (!startResp.ok)
    throw new Error(`Multipart start failed: ${startResp.status}`);
  let nextUrl = resolveUrl(uploadsUrl, startResp.headers.get("location") || "");

  // Step 2: Upload parts
  for (let part = 0; part < totalParts; part++) {
    const start = part * partSize;
    const end = Math.min(start + partSize, archive.length);
    const chunk = archive.slice(start, end);

    console.log(`Uploading part ${part + 1}/${totalParts}`);

    const partResp = await fetch(nextUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: chunk.buffer as ArrayBuffer,
    });

    if (!partResp.ok)
      throw new Error(`Part ${part + 1} upload failed: ${partResp.status}`);
    nextUrl = resolveUrl(uploadsUrl, partResp.headers.get("location") || "");
  }

  // Step 3: Complete
  const completeResp = await fetch(nextUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!completeResp.ok)
    throw new Error(`Multipart complete failed: ${completeResp.status}`);
  const data = (await completeResp.json()) as { uri: string };
  console.log(`Multipart upload complete: ${data.uri}`);
  return data.uri;
}

function resolveUrl(base: string, location: string): string {
  if (location.startsWith("/")) return base + location;
  return location;
}
