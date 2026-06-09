import { describe, expect, test } from "bun:test";
import {
  MAX_FIELD_LEN,
  parseJsonBody,
  validateAuthAvailable,
  validateCommonFields,
  validateFieldLengths,
} from "./validate";

function jsonRequest(body: string): Request {
  return new Request("http://localhost/api/migrations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("validateCommonFields", () => {
  test("accepts an empty object", () => {
    expect(validateCommonFields({})).toBeNull();
  });

  test("accepts well-formed boolean and visibility fields", () => {
    expect(
      validateCommonFields({
        lockSource: true,
        skipReleases: false,
        targetRepoVisibility: "private",
      }),
    ).toBeNull();
  });

  test("rejects a non-boolean boolean field", () => {
    const err = validateCommonFields({ lockSource: "yes" });
    expect(err).toContain("lockSource");
    expect(err).toContain("boolean");
  });

  test("rejects an invalid targetRepoVisibility", () => {
    const err = validateCommonFields({ targetRepoVisibility: "secret" });
    expect(err).toContain("targetRepoVisibility");
  });

  test("accepts each allowed visibility value", () => {
    for (const v of ["private", "public", "internal"]) {
      expect(validateCommonFields({ targetRepoVisibility: v })).toBeNull();
    }
  });

  test("rejects a non-object app auth sub-object", () => {
    const err = validateCommonFields({ sourceApp: "nope" });
    expect(err).toContain("sourceApp");
  });

  test("rejects an app auth object missing required keys", () => {
    const err = validateCommonFields({ sourceApp: { appId: "1" } });
    expect(err).toContain("sourceApp.privateKey");
  });

  test("accepts a complete app auth object", () => {
    expect(
      validateCommonFields({
        targetApp: { appId: "1", privateKey: "key", installationId: "2" },
      }),
    ).toBeNull();
  });
});

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

describe("validateFieldLengths", () => {
  test("returns null when all string fields are within the limit", () => {
    expect(
      validateFieldLengths([
        ["targetOrg", "acme"],
        ["sourceRepo", "a/b"],
      ]),
    ).toBeNull();
  });

  test("skips non-string values", () => {
    expect(
      validateFieldLengths([
        ["x", undefined],
        ["y", 123],
        ["z", null],
      ]),
    ).toBeNull();
  });

  test("rejects a field exceeding MAX_FIELD_LEN and names it", () => {
    const err = validateFieldLengths([["targetOrg", "x".repeat(MAX_FIELD_LEN + 1)]]);
    expect(err).toContain("targetOrg");
    expect(err).toContain(String(MAX_FIELD_LEN));
  });

  test("accepts a field exactly at the limit", () => {
    expect(validateFieldLengths([["targetOrg", "x".repeat(MAX_FIELD_LEN)]])).toBeNull();
  });
});

describe("validateAuthAvailable", () => {
  // In the test env no GH_*_PAT/APP vars are set, so env auth is unavailable;
  // credentials must come from the request body.

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
