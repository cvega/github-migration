import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateAuthAvailable } from "./application/migration-policy";
import { parseJsonBody } from "./application/request-body";
import { validateCredentialScope, validateProfileCredentialScope } from "./core/credential-scope";
import { resolveEffectiveSourceApiUrl } from "./migrate/ports/source-runtime";
import { validatePersistedServerCredentialScope } from "./migrate/validate";

function jsonRequest(body: string): Request {
  return new Request("http://localhost/api/migrations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("parseJsonBody", () => {
  test("parses a JSON object body", async () => {
    const result = await parseJsonBody(jsonRequest(JSON.stringify({ sourceRepo: "a/b" })));
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.sourceRepo).toBe("a/b");
    }
  });

  test("rejects every non-object JSON body", async () => {
    for (const value of [[1, 2, 3], null, "text", 42, true]) {
      expect(await parseJsonBody(jsonRequest(JSON.stringify(value)))).toEqual({
        error: "Request body must be a JSON object",
        status: 400,
      });
    }
  });

  test("rejects malformed JSON", async () => {
    const result = await parseJsonBody(jsonRequest("{ not json"));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Invalid JSON");
      expect(result.status).toBe(400);
    }
  });

  test("rejects parseable JSON without an application/json media type", async () => {
    const request = new Request("http://localhost/api/migrations", {
      method: "POST",
      body: new Blob([JSON.stringify({ sourceRepo: "a/b" })]),
    });

    const result = await parseJsonBody(request);

    expect(result).toEqual({ error: "Content-Type must be application/json", status: 415 });
  });

  test("rejects a request with no content type", async () => {
    const request = new Request("http://localhost/api/migrations", { method: "POST" });
    expect(await parseJsonBody(request)).toEqual({
      error: "Content-Type must be application/json",
      status: 415,
    });
  });

  test("accepts application/json with parameters", async () => {
    const request = new Request("http://localhost/api/migrations", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ sourceRepo: "a/b" }),
    });

    expect(await parseJsonBody(request)).toEqual({ data: { sourceRepo: "a/b" } });
  });

  test("normalizes content type case and surrounding whitespace", async () => {
    const request = new Request("http://localhost/api/migrations", {
      method: "POST",
      headers: { "Content-Type": "  Application/JSON ; charset=utf-8" },
      body: JSON.stringify({ sourceRepo: "a/b" }),
    });

    expect(await parseJsonBody(request)).toEqual({ data: { sourceRepo: "a/b" } });
  });
});

describe("validateAuthAvailable", () => {
  // validateAuthAvailable consults env-level auth via isSource/TargetAuthAvailable,
  // which read process.env live. `bun test` auto-loads .env, so to exercise the
  // "auth missing" paths deterministically each test fully controls these keys
  // (saved/cleared before, restored after) regardless of the ambient environment.
  const ENV_AUTH_KEYS = [
    "GH_SOURCE_PAT",
    "GH_TARGET_PAT",
    "GH_SOURCE_APP_ID",
    "GH_SOURCE_APP_PRIVATE_KEY",
    "GH_SOURCE_APP_INSTALLATION_ID",
    "GH_TARGET_APP_ID",
    "GH_TARGET_APP_PRIVATE_KEY",
    "GH_TARGET_APP_INSTALLATION_ID",
    "GH_ALLOW_CREDENTIAL_OVERRIDE",
    "GH_ALLOWED_SOURCE_API_URLS",
    "GH_SOURCE_API_URL",
    "GH_SOURCE_ORG",
    "GH_TARGET_ORG",
    "GITLAB_SOURCE_API_URL",
    "GITLAB_SOURCE_PAT",
    "GITLAB_SOURCE_NAMESPACE",
    "BITBUCKET_SERVER_URL",
    "BITBUCKET_SERVER_USERNAME",
    "BITBUCKET_SERVER_PASSWORD",
    "BITBUCKET_SERVER_PROJECT_KEYS",
    "PROFILE_CONNECTION_SCOPE",
    "BITBUCKET_SERVER_ALLOW_INSECURE_HTTP",
    "BITBUCKET_SERVER_SSH_USERNAME",
    "BITBUCKET_SERVER_SSH_PRIVATE_KEY",
    "BITBUCKET_SERVER_SSH_HOST_KEY_SHA256",
    "ARCHIVE_DIR",
    "GHES_TARGET_API_URL",
    "GHES_TARGET_ORG",
    "GHES_TARGET_ADMIN_USERNAME",
    "GHES_TARGET_ADMIN_PAT",
    "GHES_TARGET_SSH_PRIVATE_KEY",
    "GHES_TARGET_SSH_HOST_KEY_SHA256",
    "BBS_EXPORTER_IMAGE",
    "EXPORTER_ARCHIVE_VOLUME",
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_AUTH_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_AUTH_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test("connection-wide profiling does not widen migration or other providers' scope", () => {
    process.env.PROFILE_CONNECTION_SCOPE = "bitbucket-server";
    process.env.BITBUCKET_SERVER_PROJECT_KEYS = "TEST";
    process.env.GITLAB_SOURCE_NAMESPACE = "platform";
    expect(validateProfileCredentialScope("bitbucket-server", "PROF01")).toBeNull();
    expect(validateProfileCredentialScope("gitlab", "other")).toContain("not configured");
    expect(
      validateCredentialScope({
        sourceProvider: "bitbucket-server",
        sourceRepo: "PROF01/service-01",
      }),
    ).toContain("not configured");
  });

  test("accepts a per-request token on both sides", () => {
    expect(validateAuthAvailable({ sourceToken: "s", targetToken: "t" })).toBeNull();
  });

  test("accepts a per-request app on both sides", () => {
    expect(
      validateAuthAvailable({ sourceApp: { appId: "1" }, targetApp: { appId: "2" } }),
    ).toBeNull();
  });

  test("rejects when source auth is missing", () => {
    const err = validateAuthAvailable({ targetToken: "t" });
    expect(err).toContain("source");
  });

  test("rejects when target auth is missing", () => {
    const err = validateAuthAvailable({ sourceToken: "s" });
    expect(err).toContain("target");
  });

  test("rejects request credentials when credential override is disabled", () => {
    process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = "false";
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";

    expect(validateAuthAvailable({ sourceToken: "request-source" })).toMatch(/override.*disabled/i);
  });

  test("allows server credentials when credential override is disabled", () => {
    process.env.GH_ALLOW_CREDENTIAL_OVERRIDE = "false";
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";

    expect(validateAuthAvailable({})).toBeNull();
  });

  test("accepts server credentials for the exact configured source API base", () => {
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3";

    expect(validateAuthAvailable({ sourceApiUrl: "https://ghes.example.com/api/v3/" })).toBeNull();
  });

  test("uses the configured source API base when server credentials omit the URL", () => {
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3";

    expect(validateAuthAvailable({})).toBeNull();
    expect(resolveEffectiveSourceApiUrl({})).toBe("https://ghes.example.com/api/v3");
  });

  test("rejects a same-origin API path substitution when using server credentials", () => {
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3";

    expect(
      validateAuthAvailable({ sourceApiUrl: "https://ghes.example.com/custom/api/v3" }),
    ).toMatch(/source API URL.*server-configured/i);
  });

  test("rejects a different source API origin when using server credentials", () => {
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3";

    expect(validateAuthAvailable({ sourceApiUrl: "https://attacker.example/api/v3" })).toMatch(
      /source API URL.*server-configured/i,
    );
  });

  test("allows another source origin when the caller supplies source credentials", () => {
    process.env.GH_TARGET_PAT = "env-target";
    process.env.GH_ALLOWED_SOURCE_API_URLS = "https://another-ghes.example/api/v3";
    expect(
      validateAuthAvailable({
        sourceApiUrl: "https://another-ghes.example/api/v3",
        sourceToken: "caller-owned",
      }),
    ).toBeNull();
  });

  test("rejects an unlisted source origin even when the caller supplies credentials", () => {
    process.env.GH_TARGET_PAT = "env-target";
    expect(
      validateAuthAvailable({
        sourceApiUrl: "https://internal.example/api/v3",
        sourceToken: "caller-owned",
      }),
    ).toMatch(/administrator-approved source allowlist/i);
  });

  test("limits server credentials to configured source and target organizations", () => {
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";
    process.env.GH_SOURCE_ORG = "acme, platform";
    process.env.GH_TARGET_ORG = "acme-cloud";

    expect(validateAuthAvailable({ sourceRepo: "other/widget", targetOrg: "acme-cloud" })).toMatch(
      /source organization.*not configured/i,
    );
    expect(validateAuthAvailable({ sourceRepo: "acme/widget", targetOrg: "other-cloud" })).toMatch(
      /target organization.*not configured/i,
    );
    expect(
      validateAuthAvailable({ sourceRepo: "ACME/widget", targetOrg: "ACME-CLOUD" }),
    ).toBeNull();
  });

  test("checks server source scope across single, list, and mapped repository inputs", () => {
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";
    process.env.GH_SOURCE_ORG = "acme";

    expect(validateAuthAvailable({ sourceRepo: "other/widget" })).toContain("'other'");
    expect(validateAuthAvailable({ repos: ["acme/a", "other/b"] })).toContain("'other'");
    expect(
      validateAuthAvailable({
        items: [{ sourceRepo: "acme/a" }, { sourceRepo: "other/b" }],
      }),
    ).toContain("'other'");
    expect(
      validateAuthAvailable({ repos: ["acme/a"], items: [{ sourceRepo: "acme/b" }] }),
    ).toBeNull();
  });

  test("does not restrict repositories when no source namespaces are configured", () => {
    expect(validateCredentialScope({ sourceRepo: "anywhere/widget" })).toBeNull();
    expect(
      validateCredentialScope({ sourceProvider: "gitlab", sourceRepo: "anywhere/widget" }),
    ).toBeNull();
    expect(
      validateCredentialScope({
        sourceProvider: "bitbucket-server",
        sourceRepo: "ANYWHERE/widget",
      }),
    ).toBeNull();
    expect(validateProfileCredentialScope("gitlab", "anywhere")).toBeNull();
    expect(validateProfileCredentialScope("bitbucket-server", "ANYWHERE")).toBeNull();
  });

  test("ignores malformed repository identities but still checks valid identities", () => {
    process.env.GH_SOURCE_ORG = "acme";

    expect(validateCredentialScope({ repos: ["not-a-repository", "acme/widget"] })).toBeNull();
    expect(validateCredentialScope({ repos: ["not-a-repository", "other/widget"] })).toContain(
      "'other'",
    );
  });

  test("ignores malformed optional scope inputs without widening configured scope", () => {
    process.env.GH_SOURCE_ORG = "acme";
    process.env.GH_TARGET_ORG = "acme-cloud";

    expect(
      validateCredentialScope({
        sourceRepo: 42,
        repos: [null, 7, "acme/widget"],
        items: [null, "text", {}, { sourceRepo: 9 }, { sourceRepo: "acme/other" }],
        targetOrg: 42,
      }),
    ).toBeNull();
    expect(
      validateCredentialScope({
        repos: [null, "other/widget"],
        items: [{ sourceRepo: "acme/allowed" }],
      }),
    ).toContain("'other'");
    expect(
      validateCredentialScope({
        sourceRepo: "acme/widget",
        repos: "not-an-array",
        items: 42,
        targetProfileId: 42,
      }),
    ).toBeNull();
  });

  test("validates profile and persisted server credential scopes", () => {
    process.env.GH_SOURCE_PAT = "env-source";
    process.env.GH_TARGET_PAT = "env-target";
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3";
    process.env.GH_SOURCE_ORG = "acme";

    expect(validateProfileCredentialScope("github", "ACME")).toBeNull();
    expect(validateProfileCredentialScope("github", "other")).toBe(
      "Source organization 'other' is not configured for server credentials",
    );
    expect(
      validatePersistedServerCredentialScope({
        sourceRepo: "acme/widget",
        sourceApiUrl: "https://ghes.example.com/api/v3",
      }),
    ).toBeNull();
    expect(
      validatePersistedServerCredentialScope({
        sourceRepo: "acme/widget",
        sourceApiUrl: "https://other.example.com/api/v3",
      }),
    ).toBe("Persisted source API URL no longer matches the server-configured source");
  });

  test("profile scope accepts the matching member of a trimmed multi-scope list", () => {
    expect(validateProfileCredentialScope("github", "unrestricted")).toBeNull();

    process.env.GH_SOURCE_ORG = " first,  SECOND ";
    expect(validateProfileCredentialScope("github", "second")).toBeNull();
    expect(validateProfileCredentialScope("github", "third")).toContain("not configured");

    process.env.GITLAB_SOURCE_NAMESPACE = " platform, services/core ";
    expect(validateProfileCredentialScope("gitlab", "services/core/api")).toBeNull();

    process.env.BITBUCKET_SERVER_PROJECT_KEYS = " FIRST, PROJECT ";
    expect(validateProfileCredentialScope("bitbucket-server", "project")).toBeNull();
    expect(validateProfileCredentialScope("bitbucket-server", "project/child")).toContain(
      "not configured",
    );
  });

  test("uses target-profile organizations before global target defaults", () => {
    process.env.GH_TARGET_ORG = "cloud-org";
    process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
    process.env.GHES_TARGET_ORG = "server-org";

    expect(
      validateCredentialScope({ targetProfileId: "ghes", targetOrg: "server-org" }),
    ).toBeNull();
    expect(validateCredentialScope({ targetProfileId: "ghes", targetOrg: "cloud-org" })).toContain(
      "not configured",
    );
    expect(
      validateCredentialScope({ targetProfileId: "missing", targetOrg: "cloud-org" }),
    ).toBeNull();
  });

  test("matches any configured target organization", () => {
    process.env.GH_TARGET_ORG = "first, second";
    expect(validateCredentialScope({ targetOrg: "SECOND" })).toBeNull();
  });

  test("reports an invalid persisted source URL without throwing", () => {
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3";
    expect(validatePersistedServerCredentialScope({ sourceApiUrl: "not-a-url" })).toBe(
      "Persisted source API URL is invalid",
    );
  });

  test("checks persisted organization scope before source URL identity", () => {
    process.env.GH_SOURCE_ORG = "acme";
    expect(validatePersistedServerCredentialScope({ sourceRepo: "other/widget" })).toContain(
      "Source organization 'other'",
    );
  });

  test("retains the provider when validating a persisted native source URL", () => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    expect(
      validatePersistedServerCredentialScope({
        sourceProvider: "gitlab",
        sourceApiUrl: "https://gitlab.example.com/api/v4",
      }),
    ).toBeNull();
  });

  test("keeps GitLab server credential scope on namespace boundaries", () => {
    process.env.GITLAB_SOURCE_NAMESPACE = "platform";

    for (const [namespace, repository] of [
      ["platform", "platform/widget"],
      ["platform/services", "platform/services/widget"],
    ] as const) {
      expect(
        validateCredentialScope({ sourceProvider: "gitlab", sourceRepo: repository }),
      ).toBeNull();
      expect(validateProfileCredentialScope("gitlab", namespace)).toBeNull();
    }

    expect(
      validateCredentialScope({
        sourceProvider: "gitlab",
        sourceRepo: "platform-secrets/payroll",
      }),
    ).toBe("GitLab namespace 'platform-secrets' is not configured for server credentials");
    expect(validateProfileCredentialScope("gitlab", "platform-secrets/payroll")).toBe(
      "Namespace 'platform-secrets/payroll' is not configured for server credentials",
    );
  });

  test("caller-owned credentials do not inherit server organization restrictions", () => {
    process.env.GH_SOURCE_ORG = "acme";
    process.env.GH_TARGET_ORG = "acme-cloud";

    expect(
      validateAuthAvailable({
        sourceRepo: "other/widget",
        targetOrg: "other-cloud",
        sourceToken: "caller-source",
        targetToken: "caller-target",
      }),
    ).toBeNull();
  });

  test("caller-owned GitHub credentials do not inherit the server source URL", () => {
    process.env.GH_SOURCE_API_URL = "https://ghes.example.com/api/v3";

    expect(resolveEffectiveSourceApiUrl({ sourceToken: "caller-token" })).toBe(
      "https://api.github.com",
    );
    expect(resolveEffectiveSourceApiUrl({ sourceApp: { appId: "1" } })).toBe(
      "https://api.github.com",
    );
    expect(resolveEffectiveSourceApiUrl({ sourceToken: "caller-token", sourceApiUrl: 42 })).toBe(
      "https://api.github.com",
    );
  });

  test("defaults non-string target IDs but rejects unknown profile names", () => {
    expect(
      validateAuthAvailable({
        sourceToken: "source-token",
        targetToken: "target-token",
        targetProfileId: 42,
      }),
    ).toBeNull();
    expect(
      validateAuthAvailable({
        sourceToken: "source-token",
        targetToken: "target-token",
        targetProfileId: "missing",
      }),
    ).toBe("Migration target profile 'missing' is not configured");
  });

  test("uses caller-provided native URLs when no server URL is configured", () => {
    expect(
      resolveEffectiveSourceApiUrl({
        sourceProvider: "gitlab",
        sourceApiUrl: "https://gitlab.example.com/api/v4",
      }),
    ).toBe("https://gitlab.example.com/api/v4");
    expect(
      resolveEffectiveSourceApiUrl({
        sourceProvider: "bitbucket-server",
        sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
      }),
    ).toBe("https://bitbucket.example.com/rest/api/1.0");
  });

  test("treats whitespace-only native URLs as omitted", () => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";

    expect(resolveEffectiveSourceApiUrl({ sourceProvider: "gitlab", sourceApiUrl: "   " })).toBe(
      "https://gitlab.example.com/api/v4",
    );
    expect(
      resolveEffectiveSourceApiUrl({ sourceProvider: "bitbucket-server", sourceApiUrl: "   " }),
    ).toBe("https://bitbucket.example.com/rest/api/1.0");
  });

  test("requires a native-provider URL from either the caller or server", () => {
    expect(() => resolveEffectiveSourceApiUrl({ sourceProvider: "gitlab" })).toThrow();
    expect(() => resolveEffectiveSourceApiUrl({ sourceProvider: "bitbucket-server" })).toThrow();
  });

  test("requires explicit opt-in for a caller-provided insecure Bitbucket URL", () => {
    const input = {
      sourceProvider: "bitbucket-server" as const,
      sourceApiUrl: "http://bitbucket.example.com/rest/api/1.0",
    };
    expect(() => resolveEffectiveSourceApiUrl(input)).toThrow();
    process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = "true";
    expect(resolveEffectiveSourceApiUrl(input)).toBe("http://bitbucket.example.com/rest/api/1.0");
  });

  test("trims allowlist entries and ignores blank or invalid administrator URLs", () => {
    process.env.GH_TARGET_PAT = "target-token";
    process.env.GH_ALLOWED_SOURCE_API_URLS = " , not-a-url, https://allowed.example.com/api/v3/ , ";

    expect(
      validateAuthAvailable({
        sourceToken: "caller-token",
        sourceApiUrl: "https://allowed.example.com/api/v3",
      }),
    ).toBeNull();
    expect(
      validateAuthAvailable({
        sourceToken: "caller-token",
        sourceApiUrl: "https://not-allowed.example.com/api/v3",
      }),
    ).toContain("administrator-approved");
  });

  test("categorizes an invalid requested source URL before capability checks", () => {
    expect(
      validateAuthAvailable({
        sourceToken: "source-token",
        targetToken: "target-token",
        sourceApiUrl: "not-a-url",
      }),
    ).toBe("Source API URL is invalid");
  });

  test("accepts native Bitbucket server credentials and configured SFTP", () => {
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "bitbucket-password";
    process.env.BITBUCKET_SERVER_PROJECT_KEYS = "PLATFORM";
    process.env.BITBUCKET_SERVER_SSH_USERNAME = "bitbucket";
    process.env.BITBUCKET_SERVER_SSH_PRIVATE_KEY = "private-key";
    process.env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256 = "fingerprint";
    process.env.ARCHIVE_DIR = "/tmp/bitbucket-archives";
    process.env.GH_TARGET_PAT = "target-token";

    const input = {
      sourceProvider: "bitbucket-server" as const,
      sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
      sourceRepo: "PLATFORM/widget",
      targetOrg: "acme-cloud",
    };
    expect(validateAuthAvailable(input)).toBeNull();
    expect(resolveEffectiveSourceApiUrl(input)).toBe("https://bitbucket.example.com/rest/api/1.0");
  });

  test("normalizes padded native-provider URLs and controls insecure Bitbucket HTTP", () => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";

    expect(
      resolveEffectiveSourceApiUrl({
        sourceProvider: "gitlab",
        sourceApiUrl: "  https://gitlab.example.com/api/v4/  ",
      }),
    ).toBe("https://gitlab.example.com/api/v4");
    expect(
      resolveEffectiveSourceApiUrl({
        sourceProvider: "bitbucket-server",
        sourceApiUrl: "  https://bitbucket.example.com/rest/api/1.0/  ",
      }),
    ).toBe("https://bitbucket.example.com/rest/api/1.0");

    process.env.BITBUCKET_SERVER_URL = "http://bitbucket.example.com";
    expect(() => resolveEffectiveSourceApiUrl({ sourceProvider: "bitbucket-server" })).toThrow();
    process.env.BITBUCKET_SERVER_ALLOW_INSECURE_HTTP = "true";
    expect(resolveEffectiveSourceApiUrl({ sourceProvider: "bitbucket-server" })).toBe(
      "http://bitbucket.example.com/rest/api/1.0",
    );
  });

  test("accepts native GitLab credentials, archive storage, and nested namespaces", () => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    process.env.GITLAB_SOURCE_PAT = "gitlab-token";
    process.env.GITLAB_SOURCE_NAMESPACE = "platform";
    process.env.ARCHIVE_DIR = "/tmp/gitlab-archives";
    process.env.GH_TARGET_PAT = "target-token";

    const input = {
      sourceProvider: "gitlab" as const,
      sourceApiUrl: "https://gitlab.example.com/api/v4/",
      sourceRepo: "platform/services/widget",
      targetOrg: "acme-cloud",
    };
    expect(validateAuthAvailable(input)).toBeNull();
    expect(resolveEffectiveSourceApiUrl(input)).toBe("https://gitlab.example.com/api/v4");
  });

  test("rejects GitLab request credentials, changed origins, and out-of-scope namespaces", () => {
    process.env.GITLAB_SOURCE_API_URL = "https://gitlab.example.com";
    process.env.GITLAB_SOURCE_PAT = "gitlab-token";
    process.env.GITLAB_SOURCE_NAMESPACE = "platform/services";
    process.env.ARCHIVE_DIR = "/tmp/gitlab-archives";
    process.env.GH_TARGET_PAT = "target-token";

    expect(
      validateAuthAvailable({
        sourceProvider: "gitlab",
        sourceToken: "request-token",
        targetToken: "target-token",
      }),
    ).toMatch(/configured on the server/i);
    expect(
      validateAuthAvailable({
        sourceProvider: "gitlab",
        sourceApiUrl: "https://other.example.com/api/v4",
        sourceRepo: "platform/services/widget",
      }),
    ).toMatch(/source API URL.*server-configured/i);
    expect(
      validateAuthAvailable({ sourceProvider: "gitlab", sourceRepo: "platform/other/widget" }),
    ).toMatch(/GitLab namespace.*not configured/i);
  });

  test("rejects Bitbucket request credentials and GitHub-only source options", () => {
    expect(
      validateAuthAvailable({
        sourceProvider: "bitbucket-server",
        sourceToken: "request-token",
        targetToken: "target-token",
      }),
    ).toMatch(/configured on the server/i);
    expect(
      validateAuthAvailable({
        sourceProvider: "bitbucket-server",
        directPassthrough: true,
        targetToken: "target-token",
      }),
    ).toMatch(/do not support/i);
  });

  test("allows GitHub source options for GitHub migrations", () => {
    expect(
      validateAuthAvailable({
        sourceToken: "source-token",
        targetToken: "target-token",
        noSslVerify: true,
      }),
    ).toBeNull();
  });

  test("rejects each GitHub-only source option for every non-GitHub provider", () => {
    const options = [
      "noSslVerify",
      "lockSource",
      "archiveSource",
      "directPassthrough",
      "gitArchivePath",
      "metadataArchivePath",
    ] as const;

    for (const sourceProvider of ["gitlab", "bitbucket-server"] as const) {
      for (const option of options) {
        expect(
          validateAuthAvailable({ sourceProvider, targetToken: "target-token", [option]: true }),
        ).toMatch(
          /do not support GitHub source archive, lock, passthrough, or SSL override options/,
        );
      }
    }
  });

  test("requires Bitbucket SFTP and configured project-key scope", () => {
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "bitbucket-password";
    process.env.BITBUCKET_SERVER_PROJECT_KEYS = "PLATFORM";
    process.env.GH_TARGET_PAT = "target-token";

    expect(
      validateAuthAvailable({
        sourceProvider: "bitbucket-server",
        sourceRepo: "PLATFORM/widget",
      }),
    ).toMatch(/SFTP.*not configured/i);

    process.env.BITBUCKET_SERVER_SSH_USERNAME = "bitbucket";
    process.env.BITBUCKET_SERVER_SSH_PRIVATE_KEY = "private-key";
    process.env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256 = "fingerprint";
    process.env.ARCHIVE_DIR = "/tmp/bitbucket-archives";
    expect(
      validateAuthAvailable({
        sourceProvider: "bitbucket-server",
        sourceRepo: "OTHER/widget",
      }),
    ).toMatch(/project key.*not configured/i);
  });

  test("rejects a changed Bitbucket API origin when using server credentials", () => {
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "bitbucket-password";
    process.env.BITBUCKET_SERVER_PROJECT_KEYS = "PLATFORM";
    process.env.BITBUCKET_SERVER_SSH_USERNAME = "bitbucket";
    process.env.BITBUCKET_SERVER_SSH_PRIVATE_KEY = "private-key";
    process.env.BITBUCKET_SERVER_SSH_HOST_KEY_SHA256 = "fingerprint";
    process.env.ARCHIVE_DIR = "/tmp/bitbucket-archives";
    process.env.GH_TARGET_PAT = "target-token";

    expect(
      validateAuthAvailable({
        sourceProvider: "bitbucket-server",
        sourceApiUrl: "https://other.example.com/rest/api/1.0",
        sourceRepo: "PLATFORM/widget",
      }),
    ).toBe("Source API URL must match the server-configured Bitbucket source");
  });

  test("accepts Bitbucket-to-GHES exporter execution without Bitbucket SFTP", () => {
    process.env.BITBUCKET_SERVER_URL = "https://bitbucket.example.com";
    process.env.BITBUCKET_SERVER_USERNAME = "migration-user";
    process.env.BITBUCKET_SERVER_PASSWORD = "bitbucket-password";
    process.env.BITBUCKET_SERVER_PROJECT_KEYS = "PLATFORM";
    process.env.ARCHIVE_DIR = "/tmp/bitbucket-archives";
    process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
    process.env.GHES_TARGET_ORG = "engineering";
    process.env.GHES_TARGET_ADMIN_USERNAME = "site-admin";
    process.env.GHES_TARGET_ADMIN_PAT = "site-admin-token";
    process.env.GHES_TARGET_SSH_PRIVATE_KEY =
      "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
    process.env.GHES_TARGET_SSH_HOST_KEY_SHA256 = "fingerprint";
    process.env.BBS_EXPORTER_IMAGE = "gh-migrate/bbs-exporter:latest";
    process.env.EXPORTER_ARCHIVE_VOLUME = "gh-migrate-archives";

    expect(
      validateAuthAvailable({
        sourceProvider: "bitbucket-server",
        sourceApiUrl: "https://bitbucket.example.com/rest/api/1.0",
        sourceRepo: "PLATFORM/widget",
        targetProfileId: "ghes",
        targetOrg: "engineering",
      }),
    ).toBeNull();
  });

  test("rejects caller-owned target credentials for a GHES target", () => {
    process.env.GH_SOURCE_PAT = "source-token";
    process.env.ARCHIVE_DIR = "/tmp/archives";
    process.env.GHES_TARGET_API_URL = "https://ghes.example.com";
    process.env.GHES_TARGET_ORG = "engineering";
    process.env.GHES_TARGET_ADMIN_USERNAME = "site-admin";
    process.env.GHES_TARGET_ADMIN_PAT = "site-admin-token";
    process.env.GHES_TARGET_SSH_PRIVATE_KEY = "private-key";
    process.env.GHES_TARGET_SSH_HOST_KEY_SHA256 = "fingerprint";

    for (const targetCredentials of [
      { targetToken: "request-token" },
      { targetApp: { appId: "1" } },
    ]) {
      expect(
        validateAuthAvailable({
          sourceRepo: "acme/widget",
          targetProfileId: "ghes",
          targetOrg: "engineering",
          ...targetCredentials,
        }),
      ).toBe("GHES target credentials must be configured on the server");
    }
  });
});
