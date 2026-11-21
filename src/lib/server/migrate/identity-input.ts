import { parse } from "csv-parse/sync";

const IDENTITY_SOURCE_KINDS = [
  "ghe-migrator:bitbucket-server",
  "ghe-migrator:gitlab",
  "mannequin-login",
  "mannequin-id",
] as const;

export type IdentitySourceKind = (typeof IDENTITY_SOURCE_KINDS)[number];
export interface IdentityInput {
  sourceIdentity: string;
  targetLogin: string;
}

export function isIdentitySourceKind(value: string): value is IdentitySourceKind {
  return IDENTITY_SOURCE_KINDS.some((kind) => kind === value);
}

export function validateIdentityInput(
  kind: IdentitySourceKind,
  input: IdentityInput,
): IdentityInput {
  const sourceIdentity = input.sourceIdentity.trim();
  const targetLogin = input.targetLogin.trim();
  if (
    !sourceIdentity ||
    sourceIdentity.length > 2048 ||
    Array.from(sourceIdentity).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error("Source identity is empty, too long, or contains control characters.");
  }
  if (kind.startsWith("ghe-migrator:")) {
    let url: URL;
    try {
      url = new URL(sourceIdentity);
    } catch {
      throw new Error("GHES source identities must be exact source user URLs.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "GHES source identities must be HTTP(S) user URLs without credentials, query, or fragment.",
      );
    }
  } else if (kind === "mannequin-id" && !/^[a-zA-Z0-9_=-]{1,200}$/.test(sourceIdentity)) {
    throw new Error("Enter a valid mannequin node ID.");
  } else if (
    kind === "mannequin-login" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sourceIdentity)
  ) {
    throw new Error("Enter an exact mannequin login.");
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(targetLogin)) {
    throw new Error("Enter a valid target GitHub username.");
  }
  return { sourceIdentity, targetLogin };
}

export function parseIdentityCsv(kind: IdentitySourceKind, csv: string): IdentityInput[] {
  let rows: string[][];
  try {
    rows = parse(csv, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: false });
  } catch {
    throw new Error("The CSV is malformed. Use source_identity,target_username as the header.");
  }
  if (
    rows.length < 2 ||
    rows[0]?.length !== 2 ||
    rows[0][0] !== "source_identity" ||
    rows[0][1] !== "target_username"
  ) {
    throw new Error(
      "The CSV must have source_identity,target_username headers and at least one mapping.",
    );
  }
  if (rows.length > 501) throw new Error("The CSV cannot contain more than 500 mappings.");
  const seen = new Set<string>();
  return rows.slice(1).map((row, index) => {
    let input: IdentityInput;
    try {
      input = validateIdentityInput(kind, {
        sourceIdentity: row[0] ?? "",
        targetLogin: row[1] ?? "",
      });
    } catch (error) {
      throw new Error(
        `CSV row ${index + 2}: ${error instanceof Error ? error.message : "Invalid mapping."}`,
      );
    }
    const key =
      kind === "mannequin-login" ? input.sourceIdentity.toLowerCase() : input.sourceIdentity;
    if (seen.has(key)) throw new Error(`CSV row ${index + 2}: duplicate source identity.`);
    seen.add(key);
    return input;
  });
}
