import { describe, expect, spyOn, test } from "bun:test";
import {
  doesOrgExist,
  doesRepoExist,
  isGhecSource,
  isVersionAtLeast,
  makeThrottleOptions,
  sourceBaseUrl,
} from "./github";

/**
 * Minimal Octokit stand-in for the DI-style helpers under test. These take a
 * full `InstanceType<typeof RetryOctokit>` (hundreds of methods, overloaded
 * `request`), which is impractical to construct in a unit test, so the fakes
 * implement only the methods each function calls and are cast at the test
 * boundary. The cast is a third-party-type test double — it silences no
 * production type error (the helpers' real signatures are unchanged).
 */
type FakeClient = Parameters<typeof doesOrgExist>[0];

/** Build an HTTP-style error carrying a numeric `status`, like Octokit throws. */
function httpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

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

  test("rejects an unparseable version instead of failing open", () => {
    // A non-numeric segment must NOT be treated as satisfying the minimum —
    // the GHES version gate has to fail closed, or checkGhesVersion would let
    // an unverifiable instance through.
    expect(isVersionAtLeast("garbage", "3.15.0")).toBe(false);
    expect(isVersionAtLeast("3.x.0", "3.15.0")).toBe(false);
    expect(isVersionAtLeast("", "3.15.0")).toBe(false);
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

describe("doesOrgExist", () => {
  test("true when the org is fetched successfully", async () => {
    const client = { orgs: { get: async () => ({ data: {} }) } } as unknown as FakeClient;
    expect(await doesOrgExist(client, "acme")).toBe(true);
  });

  test("false when the org returns 404", async () => {
    const client = {
      orgs: {
        get: async () => {
          throw httpError(404);
        },
      },
    } as unknown as FakeClient;
    expect(await doesOrgExist(client, "ghost")).toBe(false);
  });

  test("rethrows non-404 errors (e.g. 500)", async () => {
    const client = {
      orgs: {
        get: async () => {
          throw httpError(500);
        },
      },
    } as unknown as FakeClient;
    await expect(doesOrgExist(client, "acme")).rejects.toThrow(/HTTP 500/);
  });
});

describe("doesRepoExist", () => {
  test("true when the repo is fetched successfully", async () => {
    const client = { repos: { get: async () => ({ data: {} }) } } as unknown as FakeClient;
    expect(await doesRepoExist(client, "acme", "widget")).toBe(true);
  });

  test("false when the repo returns 404", async () => {
    const client = {
      repos: {
        get: async () => {
          throw httpError(404);
        },
      },
    } as unknown as FakeClient;
    expect(await doesRepoExist(client, "acme", "ghost")).toBe(false);
  });

  test("rethrows non-404 errors (e.g. 403)", async () => {
    const client = {
      repos: {
        get: async () => {
          throw httpError(403);
        },
      },
    } as unknown as FakeClient;
    await expect(doesRepoExist(client, "acme", "widget")).rejects.toThrow(/HTTP 403/);
  });
});
