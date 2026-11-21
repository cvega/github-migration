import { expect, test } from "bun:test";
import { parseIdentityCsv, validateIdentityInput } from "./identity-input";

test("parses identity CSV without requiring the target user to exist", () => {
  expect(
    parseIdentityCsv(
      "ghe-migrator:bitbucket-server",
      "source_identity,target_username\nhttp://source/users/alice,alice-target\n",
    ),
  ).toEqual([{ sourceIdentity: "http://source/users/alice", targetLogin: "alice-target" }]);
});

test("rejects malformed, ambiguous, or unsafe input", () => {
  expect(() =>
    parseIdentityCsv("mannequin-login", "source_identity,target_username\nAlice,one\nalice,two\n"),
  ).toThrow("duplicate");
  expect(() => parseIdentityCsv("mannequin-login", "source,target\nalice,one")).toThrow("headers");
  expect(() =>
    validateIdentityInput("ghe-migrator:bitbucket-server", {
      sourceIdentity: "https://user:secret@source/users/a",
      targetLogin: "alice",
    }),
  ).toThrow("without credentials");
});
