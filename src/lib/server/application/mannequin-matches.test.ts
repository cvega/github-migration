import { expect, test } from "bun:test";
import type { IdentityMapping } from "$lib/server/migrate/database/identity-mappings";
import { matchMannequins } from "./mannequin-matches";
import type { Mannequin } from "./mannequins";

test("matches IDs and unique logins but blocks ambiguous or duplicate decisions", () => {
  const mannequin = (id: string, login: string): Mannequin => ({
    id,
    login,
    email: null,
    createdAt: "",
    claimant: null,
  });
  const mapping = (sourceKind: string, sourceIdentity: string): IdentityMapping => ({
    targetApiUrl: "https://api.github.com",
    targetOrg: "org",
    sourceKind,
    sourceIdentity,
    targetLogin: "alice",
    status: "approved",
  });
  const byLogin = mapping("mannequin-login", "alice");
  const byId = mapping("mannequin-id", "M1");
  const noMatch = mapping("mannequin-login", "missing");
  expect(matchMannequins([byLogin, noMatch], [mannequin("M1", "Alice")]).get(byLogin)?.kind).toBe(
    "matched",
  );
  expect(
    matchMannequins([byLogin], [mannequin("M1", "alice"), mannequin("M2", "Alice")]).get(byLogin)
      ?.kind,
  ).toBe("ambiguous");
  const duplicates = matchMannequins([byLogin, byId, noMatch], [mannequin("M1", "Alice")]);
  expect(duplicates.get(byLogin)?.kind).toBe("ambiguous");
  expect(duplicates.get(byId)?.kind).toBe("ambiguous");
  expect(duplicates.get(noMatch)?.kind).toBe("missing");
});
