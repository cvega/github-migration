import { describe, expect, test } from "bun:test";
import { isVersionAtLeast } from "./github";

describe("isVersionAtLeast", () => {
  test("treats an equal version as satisfying the minimum", () => {
    expect(isVersionAtLeast("3.15.0", "3.15.0")).toBe(true);
  });

  test("accepts higher major/minor/patch versions", () => {
    expect(isVersionAtLeast("3.16.0", "3.15.0")).toBe(true);
    expect(isVersionAtLeast("4.0.0", "3.15.0")).toBe(true);
    expect(isVersionAtLeast("3.15.1", "3.15.0")).toBe(true);
  });

  test("rejects lower versions", () => {
    expect(isVersionAtLeast("3.14.9", "3.15.0")).toBe(false);
    expect(isVersionAtLeast("2.22.0", "3.15.0")).toBe(false);
  });

  test("compares minor versions numerically, not lexically (3.8 < 3.15)", () => {
    // Lexical string comparison would wrongly rank "3.8" above "3.15".
    expect(isVersionAtLeast("3.8.0", "3.15.0")).toBe(false);
    expect(isVersionAtLeast("3.15.0", "3.8.0")).toBe(true);
  });

  test("handles versions with missing patch segments", () => {
    expect(isVersionAtLeast("3.15", "3.15.0")).toBe(true);
    expect(isVersionAtLeast("3.15", "3.15.1")).toBe(false);
  });
});
