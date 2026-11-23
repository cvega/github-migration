import { parse } from "csv-parse/sync";
import { getSourceProviderAdapter } from "$lib/source-provider";

export function bitbucketGroupIdentity(apiUrl: string, project: string, group: string): string {
  if (!apiUrl) throw new Error("Configure the Bitbucket source before adding a group mapping.");
  if (!getSourceProviderAdapter("bitbucket-server").isValidNamespace(project))
    throw new Error("Enter a valid Bitbucket project key.");
  if (!group || /[\p{Cc}]/u.test(group)) throw new Error("Enter a Bitbucket group name.");
  return `${apiUrl.replace(/\/rest\/api\/1\.0$/, "")}/admin/groups/view?name=${encodeURIComponent(group)}#${encodeURIComponent(project)}`;
}

export function bitbucketUserIdentity(apiUrl: string, username: string): string {
  if (!apiUrl) throw new Error("Configure the Bitbucket source before adding a user mapping.");
  if (!username || /^[.]{1,2}$/.test(username) || /[/\\?#\p{Cc}]/u.test(username))
    throw new Error("Enter a Bitbucket username, not a URL.");
  return `${apiUrl.replace(/\/rest\/api\/1\.0$/, "")}/users/${encodeURIComponent(username)}`;
}

export function sourceIdentityLabel(kind: string, identity: string): string {
  if (!URL.canParse(identity)) return identity;
  const url = new URL(identity);
  if (kind === "ghe-migrator:bitbucket-server") {
    const slug = /\/users\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (!slug) return identity;
    try {
      return decodeURIComponent(slug);
    } catch (error) {
      if (error instanceof URIError) return slug;
      throw error;
    }
  }
  if (kind !== "ghe-migrator:bitbucket-server:team") return identity;
  const group = url.searchParams.get("name");
  return url.pathname.endsWith("/admin/groups/view") && group
    ? url.hash.slice(1) || group
    : identity;
}

const IDENTITY_SOURCE_KINDS = [
  "ghe-migrator:bitbucket-server",
  "ghe-migrator:gitlab",
  "ghe-migrator:bitbucket-server:team",
  "ghe-migrator:gitlab:team",
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
      (!kind.endsWith(":team") && (url.search || url.hash)) ||
      (kind.endsWith(":team") &&
        url.search &&
        !(
          kind === "ghe-migrator:bitbucket-server:team" &&
          url.pathname.endsWith("/admin/groups/view") &&
          [...url.searchParams.keys()].every((key) => key === "name")
        ))
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
  if (kind.endsWith(":team")) {
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(targetLogin)) {
      throw new Error("Enter the exact target GitHub team slug.");
    }
  } else if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(targetLogin)) {
    throw new Error("Enter a valid target GitHub username.");
  }
  return { sourceIdentity, targetLogin };
}

export function parseIdentityCsv(kind: IdentitySourceKind, csv: string): IdentityInput[] {
  const targetHeader = kind.endsWith(":team") ? "target_team_slug" : "target_username";
  let rows: string[][];
  try {
    rows = parse(csv, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: false });
  } catch {
    throw new Error(`The CSV is malformed. Use source_identity,${targetHeader} as the header.`);
  }
  if (
    rows.length < 2 ||
    rows[0]?.length !== 2 ||
    rows[0][0] !== "source_identity" ||
    rows[0][1] !== targetHeader
  ) {
    throw new Error(
      `The CSV must have source_identity,${targetHeader} headers and at least one mapping.`,
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
