export const DOMAIN_NAMES = ["migrate", "profile", "source"] as const;

export type Domain = (typeof DOMAIN_NAMES)[number];
export type Layer = "application" | "core" | Domain | "schemas";
export type TargetLayer = Layer | "unclassified";

export function isDomain(value: string): value is Domain {
  return DOMAIN_NAMES.some((domain) => domain === value);
}

export function checkBoundary(from: Layer, to: TargetLayer | null): string | null {
  if (to === null) return null;
  if (to === "unclassified") return "server imports must target a classified layer";
  if ((from === "core" || isDomain(from)) && to === "application") {
    return `${from}/ must not import the application layer`;
  }
  if (from === "core" && isDomain(to)) {
    return "core/ must not import a domain";
  }
  if (from === "core" && to === "schemas") {
    return "core/ must not import schemas.ts (composition root)";
  }
  if (isDomain(from) && isDomain(to) && to !== from) {
    return `domain '${from}' must not import domain '${to}'`;
  }
  if (isDomain(from) && to === "schemas") {
    return `domain '${from}' must not import schemas.ts (composition root)`;
  }
  return null;
}
