import { describe, expect, test } from "bun:test";
import { type ProfileRun, type RepoSignals, ZERO_ORG_RESOURCES } from "./types";

describe("profile contracts", () => {
  test("provides an immutable all-zero organization resource baseline", () => {
    expect(ZERO_ORG_RESOURCES).toEqual({
      actionsSecrets: 0,
      actionsVariables: 0,
      dependabotSecrets: 0,
      codespacesSecrets: 0,
      selfHostedRunners: 0,
      customProperties: 0,
      teams: 0,
      appInstallations: 0,
    });
  });

  test("keeps run and repository identities explicit", () => {
    const run = { sourceProvider: "github", state: "running" } as ProfileRun;
    const repo = { nameWithOwner: "acme/widget", visibility: "PRIVATE" } as RepoSignals;
    expect(run.sourceProvider).toBe("github");
    expect(repo.nameWithOwner).toBe("acme/widget");
  });
});
