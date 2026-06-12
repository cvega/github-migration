import { describe, expect, spyOn, test } from "bun:test";
import { isGhecSource, isVersionAtLeast, makeThrottleOptions, sourceBaseUrl } from "./github";

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

describe("isGhecSource", () => {
  test("true for the github.com API host", () => {
    expect(isGhecSource("https://api.github.com")).toBe(true);
  });

  test("true for a GHE.com data-residency tenant", () => {
    expect(isGhecSource("https://api.acme.ghe.com")).toBe(true);
    expect(isGhecSource("https://acme.ghe.com")).toBe(true);
  });

  test("false for a GHES host", () => {
    expect(isGhecSource("https://ghes.example.com/api/v3")).toBe(false);
  });

  test("false for a self-hosted host containing 'github' (e.g. github.mycompany.com)", () => {
    expect(isGhecSource("https://github.mycompany.com/api/v3")).toBe(false);
  });
});

describe("sourceBaseUrl", () => {
  test("maps the github.com API to github.com", () => {
    expect(sourceBaseUrl("https://api.github.com")).toBe("https://github.com");
  });

  test("maps a GHE.com data-residency API host to its web host", () => {
    expect(sourceBaseUrl("https://api.acme.ghe.com")).toBe("https://acme.ghe.com");
  });

  test("strips a trailing /api/v3 from a GHES URL", () => {
    expect(sourceBaseUrl("https://ghes.example.com/api/v3")).toBe("https://ghes.example.com");
  });

  test("strips a trailing slash", () => {
    expect(sourceBaseUrl("https://ghes.example.com/")).toBe("https://ghes.example.com");
  });
});

describe("makeThrottleOptions", () => {
  const reqOptions = { url: "/repos/acme/widget" };

  test("onRateLimit retries while under the 3-attempt cap", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { onRateLimit } = makeThrottleOptions();

    expect(onRateLimit(5, reqOptions, {}, 0)).toBe(true);
    expect(onRateLimit(5, reqOptions, {}, 2)).toBe(true);

    warn.mockRestore();
  });

  test("onRateLimit stops retrying at the cap", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { onRateLimit } = makeThrottleOptions();

    expect(onRateLimit(5, reqOptions, {}, 3)).toBe(false);
    expect(onRateLimit(5, reqOptions, {}, 10)).toBe(false);

    warn.mockRestore();
  });

  test("onSecondaryRateLimit follows the same retry cap", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { onSecondaryRateLimit } = makeThrottleOptions();

    expect(onSecondaryRateLimit(5, reqOptions, {}, 0)).toBe(true);
    expect(onSecondaryRateLimit(5, reqOptions, {}, 2)).toBe(true);
    expect(onSecondaryRateLimit(5, reqOptions, {}, 3)).toBe(false);

    warn.mockRestore();
  });

  test("logs a warning when a rate limit is hit", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { onRateLimit } = makeThrottleOptions();

    onRateLimit(5, reqOptions, {}, 0);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
