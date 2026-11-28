import { describe, expect, test } from "bun:test";
import { ConfigIssueError, collectConfigIssues } from "./config-issue";

describe("configuration issues", () => {
  test("describe a variable and a fixed rule only", () => {
    const error = new ConfigIssueError("ARCHIVE_DIR", "absolute-path");
    expect(error.message).toBe("ARCHIVE_DIR must be an absolute path");
    expect(error.issue).toEqual({ variable: "ARCHIVE_DIR", text: error.message });
  });

  test("refuses a variable name that could carry a value", () => {
    expect(() => new ConfigIssueError("ARCHIVE_DIR=/srv/private", "required")).toThrow(
      /environment variable name/,
    );
    expect(() => new ConfigIssueError("lower_case", "required")).toThrow(
      /environment variable name/,
    );
  });

  test("collects one issue per failing check and ignores passing checks", () => {
    const issues = collectConfigIssues([
      () => "ok",
      () => {
        throw new ConfigIssueError("EXPORTER_ARCHIVE_VOLUME", "required");
      },
      () => {
        throw new ConfigIssueError("ARCHIVE_DIR", "absolute-path");
      },
    ]);
    expect(issues.map((issue) => issue.text)).toEqual([
      "EXPORTER_ARCHIVE_VOLUME is required",
      "ARCHIVE_DIR must be an absolute path",
    ]);
  });

  test("reports unexpected errors generically without echoing their message", () => {
    const issues = collectConfigIssues([
      () => {
        throw new TypeError("Invalid URL: https://user:synthetic-secret@example.invalid");
      },
    ]);
    expect(issues).toEqual([{ variable: null, text: "Configuration is invalid" }]);
  });
});
