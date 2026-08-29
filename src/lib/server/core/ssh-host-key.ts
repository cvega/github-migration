import { createHash, timingSafeEqual } from "node:crypto";

const OPENSSH_SHA256_FINGERPRINT = /^[A-Za-z0-9+/]{43}$/;

function fingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export function verifySshHostKey(key: Buffer, configuredFingerprint: string): boolean {
  if (!Buffer.isBuffer(key)) return false;
  const expected = configuredFingerprint.trim().replace(/^SHA256:/i, "");
  if (!OPENSSH_SHA256_FINGERPRINT.test(expected)) return false;

  const actualBytes = Buffer.from(fingerprint(key), "ascii");
  const expectedBytes = Buffer.from(expected, "ascii");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
