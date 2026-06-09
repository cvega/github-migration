import { describe, expect, test } from "bun:test";
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
