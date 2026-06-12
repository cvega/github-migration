import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseJsonBody, validateAuthAvailable } from "./validate";

function jsonRequest(body: string): Request {
  return new Request("http://localhost/api/migrations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("parseJsonBody", () => {
  test("parses a JSON object body", async () => {
    const result = await parseJsonBody(jsonRequest(JSON.stringify({ sourceRepo: "a/b" })));
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.sourceRepo).toBe("a/b");
    }
  });

  test("rejects a non-object (array) body", async () => {
    const result = await parseJsonBody(jsonRequest(JSON.stringify([1, 2, 3])));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("JSON object");
    }
  });

  test("rejects malformed JSON", async () => {
    const result = await parseJsonBody(jsonRequest("{ not json"));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Invalid JSON");
    }
  });
});

describe("validateAuthAvailable", () => {
  // validateAuthAvailable consults env-level auth via isSource/TargetAuthAvailable,
  // which read process.env live. `bun test` auto-loads .env, so to exercise the
  // "auth missing" paths deterministically each test fully controls these keys
  // (saved/cleared before, restored after) regardless of the ambient environment.
  const ENV_AUTH_KEYS = [
    "GH_SOURCE_PAT",
    "GH_TARGET_PAT",
    "GH_SOURCE_APP_ID",
    "GH_SOURCE_APP_PRIVATE_KEY",
    "GH_SOURCE_APP_INSTALLATION_ID",
    "GH_TARGET_APP_ID",
    "GH_TARGET_APP_PRIVATE_KEY",
    "GH_TARGET_APP_INSTALLATION_ID",
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_AUTH_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_AUTH_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test("accepts a per-request token on both sides", () => {
    expect(validateAuthAvailable({ sourceToken: "s", targetToken: "t" })).toBeNull();
  });

  test("accepts a per-request app on both sides", () => {
    expect(
      validateAuthAvailable({ sourceApp: { appId: "1" }, targetApp: { appId: "2" } }),
    ).toBeNull();
  });

  test("rejects when source auth is missing", () => {
    const err = validateAuthAvailable({ targetToken: "t" });
    expect(err).toContain("source");
  });

  test("rejects when target auth is missing", () => {
    const err = validateAuthAvailable({ sourceToken: "s" });
    expect(err).toContain("target");
  });
});
