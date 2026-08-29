import { describe, expect, test } from "bun:test";
import {
  getGitHubSourcePlatform,
  getMigrationExecutor,
  getSourceProjectIdentity,
  getSourceProviderAdapter,
  isSourceProvider,
  sourceBaseUrl,
  sourceProjectUrl,
} from "./source-provider";

describe("source provider adapters", () => {
  test("recognizes only supported explicit providers", () => {
    expect(isSourceProvider("github")).toBe(true);
    expect(isSourceProvider("gitlab")).toBe(true);
    expect(isSourceProvider("bitbucket-server")).toBe(true);
    expect(isSourceProvider("https://gitlab.example.com")).toBe(false);
    expect(isSourceProvider(null)).toBe(false);
    expect(isSourceProvider(1)).toBe(false);
  });

  test("classifies only GitHub cloud hosts as GHEC", () => {
    expect(getGitHubSourcePlatform("https://api.github.com")).toBe("ghec");
    expect(getGitHubSourcePlatform("https://github.com")).toBe("ghec");
    expect(getGitHubSourcePlatform("https://acme.ghe.com")).toBe("ghec");
    expect(getGitHubSourcePlatform("https://github.example.com/api/v3")).toBe("ghes");
    expect(getGitHubSourcePlatform("not-a-url")).toBe("ghes");
    expect(getGitHubSourcePlatform(null)).toBe("ghes");
  });

  test("maps GitHub API URLs to repository web hosts", () => {
    expect(sourceBaseUrl("https://api.github.com")).toBe("https://github.com");
    expect(sourceBaseUrl("https://github.com")).toBe("https://github.com");
    expect(sourceBaseUrl("https://api.acme.ghe.com/api/v3///")).toBe("https://acme.ghe.com");
    expect(sourceBaseUrl("https://ghes.example.com/api/v3///")).toBe("https://ghes.example.com");
    expect(sourceBaseUrl("https://ghes.example.com/api/v3/repos")).toBe(
      "https://ghes.example.com/api/v3/repos",
    );
    expect(sourceBaseUrl("not-a-url/api/v3/")).toBe("not-a-url");
  });

  test("maps provider API identities to repository web URLs", () => {
    expect(sourceProjectUrl("github", "https://api.github.com", "octo", "widget")).toBe(
      "https://github.com/octo/widget",
    );
    expect(
      sourceProjectUrl(
        "gitlab",
        "https://gitlab.example.com/api/v4",
        "platform/services",
        "widget",
      ),
    ).toBe("https://gitlab.example.com/platform/services/widget");
    expect(
      sourceProjectUrl(
        "bitbucket-server",
        "https://bitbucket.example.com/rest/api/1.0",
        "PLATFORM",
        "widget.repo",
      ),
    ).toBe("https://bitbucket.example.com/projects/PLATFORM/repos/widget.repo");
    expect(
      sourceProjectUrl(
        "gitlab",
        "https://gitlab.example.com/api/v4/",
        "platform/research#labs",
        "widget?next",
      ),
    ).toBe("https://gitlab.example.com/platform/research%23labs/widget%3Fnext");
  });

  test("requires both an enabled capability and an explicit executor", () => {
    const adapter = getSourceProviderAdapter("github");
    expect(getMigrationExecutor("github")).toBe("github-api");
    expect(getMigrationExecutor("gitlab")).toBe("gitlab-native");
    expect(getMigrationExecutor("gitlab", "ghes")).toBe("gitlab-ghes");
    expect(getMigrationExecutor("github", "ghes")).toBeNull();
    expect(getMigrationExecutor("bitbucket-server", "ghes")).toBe("bitbucket-server-ghes");
    expect(getMigrationExecutor("bitbucket-server")).toBe("bitbucket-server-native");

    adapter.capabilities.migrationExecution = false;
    try {
      expect(getMigrationExecutor("github")).toBeNull();
    } finally {
      adapter.capabilities.migrationExecution = true;
    }
  });

  test("keeps GitHub identities to owner/repository", () => {
    const adapter = getSourceProviderAdapter("github");

    expect(adapter.isValidNamespace("octo-org")).toBe(true);
    expect(adapter.isValidNamespace("-octo")).toBe(false);
    expect(adapter.isValidNamespace("octo!")).toBe(false);
    expect(adapter.isValidProjectPath("octo/widget")).toBe(true);
    expect(adapter.isValidProjectPath("widget")).toBe(false);
    expect(adapter.isValidProjectPath("octo/platform/widget")).toBe(false);
    expect(adapter.isProjectInNamespace("Octo/widget", "octo")).toBe(true);
    expect(adapter.isProjectInNamespace("other/widget", "octo")).toBe(false);
    expect(adapter.isProjectInNamespace("invalid", "octo")).toBe(false);
    expect(adapter.projectName("octo/widget")).toBe("widget");
    expect(adapter.projectName("invalid")).toBe("");
    expect(adapter.provider).toBe("github");
    expect(adapter.displayName).toBe("GitHub");
    expect(adapter.namespaceLabel).toBe("organization login");
    expect(adapter.profileKind).toBe("github-readiness");
    expect(adapter.profileCapacityKey).toBe("github");
    expect(adapter.capabilities).toEqual({
      inventory: true,
      planning: true,
      migrationExecution: true,
      restart: true,
      export: true,
      requestSourceCredentials: true,
      migrationMode: true,
      skipReleases: true,
      directPassthrough: true,
      sourceTlsBypass: true,
    });
    expect(adapter.sourcePlatform("https://api.github.com")).toEqual({
      label: "GHEC",
      displayName: "GitHub Enterprise Cloud",
      icon: "mark-github",
    });
    expect(adapter.sourcePlatform("https://ghes.example.com/api/v3")).toEqual({
      label: "GHES",
      displayName: "GitHub Enterprise Server",
      icon: "mark-github",
    });
  });

  test("preserves nested GitLab namespaces and derives only the project name", () => {
    const adapter = getSourceProviderAdapter("gitlab");

    expect(adapter.isValidNamespace("platform")).toBe(true);
    expect(adapter.isValidNamespace("platform/services")).toBe(true);
    expect(adapter.isValidNamespace(`platform/${"x".repeat(255)}`)).toBe(true);
    expect(adapter.isValidNamespace("platform/../services")).toBe(false);
    expect(adapter.isValidNamespace("platform/./services")).toBe(false);
    expect(adapter.isValidNamespace(`platform/${"x".repeat(256)}`)).toBe(false);
    expect(adapter.isValidNamespace(`platform/${String.fromCharCode(0)}services`)).toBe(false);
    expect(adapter.isValidProjectPath("platform/services/widget")).toBe(true);
    expect(adapter.isValidProjectPath("widget")).toBe(false);
    expect(adapter.isValidProjectPath("platform//widget")).toBe(false);
    expect(adapter.isProjectInNamespace("platform/services/widget", "platform/services")).toBe(
      true,
    );
    expect(adapter.isProjectInNamespace("platform/service-tools/widget", "platform/services")).toBe(
      false,
    );
    expect(adapter.projectName("platform/services/widget")).toBe("widget");
    expect(adapter.projectName("invalid")).toBe("");
    expect(getSourceProjectIdentity("gitlab", "platform/services/widget")).toEqual({
      namespace: "platform/services",
      name: "widget",
    });
    expect(adapter.profileKind).toBe("source-inventory");
    expect(adapter.provider).toBe("gitlab");
    expect(adapter.displayName).toBe("GitLab");
    expect(adapter.namespaceLabel).toBe("namespace path");
    expect(adapter.profileCapacityKey).toBe("gitlab");
    expect(adapter.capabilities).toEqual({
      inventory: true,
      planning: true,
      migrationExecution: true,
      restart: true,
      export: true,
      requestSourceCredentials: false,
      migrationMode: false,
      skipReleases: false,
      directPassthrough: false,
      sourceTlsBypass: false,
    });
    expect(adapter.sourcePlatform("https://gitlab.example.com/api/v4")).toEqual({
      label: "GitLab",
      displayName: "GitLab",
      icon: "gitlab-logo",
    });
  });

  test("uses Bitbucket project keys and repository slugs as canonical identity", () => {
    const adapter = getSourceProviderAdapter("bitbucket-server");

    expect(adapter.isValidNamespace("PLATFORM_1")).toBe(true);
    expect(adapter.isValidNamespace("platform-team")).toBe(true);
    expect(adapter.isValidNamespace("platform/team")).toBe(false);
    expect(adapter.isValidProjectPath("PLATFORM_1/widget.repo")).toBe(true);
    expect(adapter.isValidProjectPath(`PLATFORM_1/${"x".repeat(255)}`)).toBe(true);
    expect(adapter.isValidProjectPath(`PLATFORM_1/${"x".repeat(256)}`)).toBe(false);
    expect(adapter.isValidProjectPath("PLATFORM_1/nested/widget")).toBe(false);
    expect(adapter.isProjectInNamespace("platform_1/widget", "PLATFORM_1")).toBe(true);
    expect(adapter.isProjectInNamespace("other/widget", "PLATFORM_1")).toBe(false);
    expect(adapter.isProjectInNamespace("invalid", "PLATFORM_1")).toBe(false);
    expect(adapter.projectName("PLATFORM_1/widget.repo")).toBe("widget.repo");
    expect(adapter.projectName("invalid")).toBe("");
    expect(adapter.provider).toBe("bitbucket-server");
    expect(adapter.displayName).toBe("Bitbucket Server");
    expect(adapter.namespaceLabel).toBe("project key");
    expect(adapter.profileKind).toBe("source-inventory");
    expect(adapter.profileCapacityKey).toBe("bitbucket-server");
    expect(adapter.migrationExecutor).toBe("bitbucket-server-native");
    expect(adapter.capabilities).toEqual({
      inventory: true,
      planning: true,
      migrationExecution: true,
      restart: true,
      export: true,
      requestSourceCredentials: false,
      migrationMode: false,
      skipReleases: true,
      directPassthrough: false,
      sourceTlsBypass: false,
    });
    expect(adapter.sourcePlatform("https://bitbucket.example.com/rest/api/1.0")).toEqual({
      label: "Bitbucket Server",
      displayName: "Bitbucket Server",
      icon: "bitbucket-logo",
    });
  });

  test("enforces complete-path length and rejects invalid project identities", () => {
    const gitlab = getSourceProviderAdapter("gitlab");
    const pathAtLimit = [
      ...Array.from({ length: 7 }, () => "x".repeat(255)),
      "x".repeat(254),
      "x",
    ].join("/");
    const pathOverLimit = [...Array.from({ length: 8 }, () => "x".repeat(255)), "x"].join("/");

    expect(pathAtLimit).toHaveLength(2_048);
    expect(pathOverLimit).toHaveLength(2_049);
    expect(gitlab.isValidProjectPath(pathAtLimit)).toBe(true);
    expect(gitlab.isValidProjectPath(pathOverLimit)).toBe(false);
    expect(() => getSourceProjectIdentity("github", "invalid")).toThrow(
      "GitHub source repository path is invalid",
    );
  });
});
