import type { IdentityMapping } from "$lib/server/migrate/database/identity-mappings";
import type { Mannequin } from "./mannequins";

export type MannequinMatch =
  | { kind: "matched"; mannequin: Mannequin }
  | { kind: "missing" | "ambiguous" };

export function matchMannequins(
  mappings: IdentityMapping[],
  mannequins: Mannequin[],
): Map<IdentityMapping, MannequinMatch> {
  const results = new Map<IdentityMapping, MannequinMatch>();
  const owners = new Map<string, IdentityMapping[]>();
  for (const mapping of mappings) {
    const candidates = mannequins.filter((mannequin) =>
      mapping.sourceKind === "mannequin-id"
        ? mannequin.id === mapping.sourceIdentity
        : mapping.sourceKind === "mannequin-login" &&
          mannequin.login.toLowerCase() === mapping.sourceIdentity.toLowerCase(),
    );
    if (candidates.length === 0) results.set(mapping, { kind: "missing" });
    else if (candidates.length > 1) results.set(mapping, { kind: "ambiguous" });
    else {
      const mannequin = candidates[0];
      if (!mannequin) throw new Error("Missing mannequin match.");
      results.set(mapping, { kind: "matched", mannequin });
      owners.set(mannequin.id, [...(owners.get(mannequin.id) ?? []), mapping]);
    }
  }
  for (const sameMannequin of owners.values()) {
    if (sameMannequin.length > 1) {
      for (const mapping of sameMannequin) results.set(mapping, { kind: "ambiguous" });
    }
  }
  return results;
}
