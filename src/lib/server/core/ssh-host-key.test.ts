import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifySshHostKey } from "./ssh-host-key";

describe("SSH host-key verification", () => {
  const key = Buffer.from("ssh-host-public-key");
  const fingerprint = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

  test("accepts OpenSSH fingerprints with or without the SHA256 prefix", () => {
    expect(verifySshHostKey(key, fingerprint)).toBe(true);
    expect(verifySshHostKey(key, `SHA256:${fingerprint}`)).toBe(true);
  });

  test("rejects a different key and malformed fingerprints", () => {
    expect(verifySshHostKey(Buffer.from("different-key"), fingerprint)).toBe(false);
    expect(verifySshHostKey(key, "SHA256:not-a-fingerprint")).toBe(false);
    expect(verifySshHostKey(key, "")).toBe(false);
  });
});
