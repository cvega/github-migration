import { describe, expect, test } from "bun:test";
import {
  generateTemporaryPassword,
  hashPassword,
  passwordHashNeedsUpgrade,
  passwordPolicyError,
  verifyPassword,
  verifyPasswordOrDummy,
} from "./passwords";

describe("passwords", () => {
  test("enforces the password length policy", () => {
    expect(passwordPolicyError("short")).toContain("at least 12");
    expect(passwordPolicyError("correct horse battery staple")).toBeNull();
    expect(passwordPolicyError("x".repeat(129))).toContain("no more than 128");
  });

  test("hashes with the current Argon2id policy", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$v=19$m=65536,t=3,p=1$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
    expect(passwordHashNeedsUpgrade(hash)).toBe(false);
  });

  test("performs dummy verification for an unknown user", async () => {
    expect(await verifyPasswordOrDummy("unknown password", null)).toBe(false);
  });

  test("generates policy-compliant temporary passwords", () => {
    const first = generateTemporaryPassword();
    const second = generateTemporaryPassword();
    expect(passwordPolicyError(first)).toBeNull();
    expect(first).not.toBe(second);
  });
});
