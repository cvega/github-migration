import { expect, test } from "bun:test";
import { safeErrorReason } from "./safe-error";

test("only reports recognized classes and numeric HTTP status codes", () => {
  const diagnostic = "Authorization: Bearer inert-test-token";
  const error = Object.assign(
    new TypeError(diagnostic, {
      cause: new Error("https://fixture.invalid/archive?signature=inert"),
    }),
    { name: diagnostic, status: 403 },
  );
  expect(safeErrorReason(new Error(diagnostic), "Export failed")).toBe("Export failed");
  expect(safeErrorReason(error)).toBe("TypeError");
  expect(safeErrorReason(error, "Import failed")).toBe("Import failed (HTTP 403)");
  expect(safeErrorReason({ status: diagnostic }, "Import failed")).toBe("Import failed");
});
