import { describe, expect, test } from "bun:test";
import { assertPersistableSourceApiUrl, parseSourceApiUrl } from "$lib/source/url";

describe("source API URL safety", () => {
  test("accepts credential-free HTTPS URLs and rejects insecure persistence", () => {
    expect(parseSourceApiUrl("https://code.example.com/api/v4").href).toBe(
      "https://code.example.com/api/v4",
    );
    expect(() => assertPersistableSourceApiUrl("http://ghes.example.com/api/v3")).toThrow(
      "must use HTTPS",
    );
  });

  test("rejects non-HTTP and credential-bearing URLs", () => {
    expect(() => assertPersistableSourceApiUrl("not-a-url")).toThrow(
      "Source API URL must be a valid URL",
    );
    expect(() => assertPersistableSourceApiUrl("file:///tmp/source")).toThrow(
      "Source API URL must use HTTP or HTTPS",
    );
    for (const value of [
      "https://token@code.example.com",
      "https://code.example.com?token=secret",
      "https://code.example.com#secret",
    ]) {
      expect(() => assertPersistableSourceApiUrl(value)).toThrow(
        "Source API URL must not include credentials, a query, or a fragment",
      );
    }
  });

  test("uses a caller-provided label for URL errors", () => {
    expect(() => parseSourceApiUrl("not-a-url", { label: "GitLab URL" })).toThrow(
      "GitLab URL must be a valid URL",
    );
  });

  test("can require HTTPS with a provider-specific error", () => {
    expect(() =>
      parseSourceApiUrl("http://code.example.com", {
        label: "GitLab URL",
        requireHttps: true,
        insecureHttpMessage: "GitLab URL must use HTTPS unless insecure HTTP is explicitly enabled",
      }),
    ).toThrow("must use HTTPS unless insecure HTTP is explicitly enabled");
  });
});
