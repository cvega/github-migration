import { expect, test } from "bun:test";
import { parseIdentityCsv, validateIdentityInput } from "./identity-input";

test("preserves an exact project-scoped Bitbucket group URL from a team CSV", () => {
  const source = "http://bitbucket/admin/groups/view?name=project_admin_access#TEST";
  expect(
    parseIdentityCsv(
      "ghe-migrator:bitbucket-server:team",
      `source_identity,target_team_slug\n${source},project_admin_access`,
    ),
  ).toEqual([{ sourceIdentity: source, targetLogin: "project_admin_access" }]);
  expect(() =>
    validateIdentityInput("ghe-migrator:bitbucket-server:team", {
      sourceIdentity: source,
      targetLogin: "other-org/team",
    }),
  ).toThrow("slug");
});

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
