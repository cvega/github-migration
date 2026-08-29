import { expect, test } from "bun:test";
import { validateStartProfileRequest } from "./request";

test("defaults to GitHub and trims valid namespaces", () => {
  expect(validateStartProfileRequest({ org: " acme " })).toEqual({
    ok: true,
    value: { sourceProvider: "github", org: "acme" },
  });
  expect(
    validateStartProfileRequest({ sourceProvider: "gitlab", org: " platform/services " }),
  ).toEqual({ ok: true, value: { sourceProvider: "gitlab", org: "platform/services" } });
});

test("rejects unknown providers and malformed namespaces", () => {
  expect(validateStartProfileRequest({ sourceProvider: "bitbucket", org: "ACME" })).toEqual({
    ok: false,
    error: "sourceProvider must be one of: github, gitlab, bitbucket-server",
  });
  expect(validateStartProfileRequest({ sourceProvider: "github", org: "bad/name" })).toMatchObject({
    ok: false,
  });
});
