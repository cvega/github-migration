import { describe, expect, test } from "bun:test";
import {
  MAX_SOURCE_INVENTORY_PROJECTS,
  parseSourceNamespaceInventory,
  type SourceNamespaceInventory,
} from "./inventory";

function inventory(): SourceNamespaceInventory {
  return {
    version: 1,
    provider: "gitlab",
    sourceApiUrl: "https://gitlab.example.com/api/v4",
    namespace: "platform/products",
    projectCount: { kind: "exact", value: 1 },
    projects: [
      {
        provider: "gitlab",
        sourceId: "42",
        path: "platform/products/payments-api",
        name: "payments-api",
        visibility: "private",
        archived: false,
        defaultBranch: "main",
        lastActivityAt: "2026-08-01T12:00:00Z",
        repositorySizeBytes: { kind: "exact", value: 0 },
        storageSizeBytes: { kind: "exact", value: 2_048 },
        lfsObjectsSizeBytes: { kind: "unavailable", reason: "not-reported" },
        packagesSizeBytes: { kind: "exact", value: 0 },
        wikiSizeBytes: { kind: "exact", value: 0 },
        uploadsSizeBytes: { kind: "exact", value: 0 },
        providerDetails: {
          provider: "gitlab",
          webUrl: "https://gitlab.example.com/platform/products/payments-api",
          topics: ["payments", "service"],
          emptyRepository: false,
          features: { issues: true, wiki: false },
        },
      },
    ],
  };
}

describe("parseSourceNamespaceInventory", () => {
  test("accepts a versioned, internally consistent snapshot", () => {
    const value = inventory();
    expect(parseSourceNamespaceInventory(value)).toEqual(value);
  });

  test("rejects missing versions and unsafe source URLs", () => {
    const missingVersion = { ...inventory(), version: undefined };
    expect(() => parseSourceNamespaceInventory(missingVersion)).toThrow();
    for (const sourceApiUrl of [
      "not-a-url",
      "file:///tmp/gitlab",
      "https://token@gitlab.example.com/api/v4",
      "https://gitlab.example.com/api/v4?token=secret",
    ]) {
      expect(() => parseSourceNamespaceInventory({ ...inventory(), sourceApiUrl })).toThrow();
    }
  });

  test("rejects contradictory project-count observations", () => {
    expect(() =>
      parseSourceNamespaceInventory({
        ...inventory(),
        projectCount: { kind: "exact", value: 0 },
      }),
    ).toThrow();
    expect(() =>
      parseSourceNamespaceInventory({
        ...inventory(),
        projectCount: { kind: "at-least", value: 2 },
      }),
    ).toThrow();
    expect(() =>
      parseSourceNamespaceInventory({
        ...inventory(),
        projectCount: { kind: "unavailable", reason: "forbidden" },
      }),
    ).toThrow();
  });

  test("rejects provider/path mismatches and duplicate identities", () => {
    const providerMismatch = inventory();
    providerMismatch.projects[0] = { ...providerMismatch.projects[0]!, provider: "github" };
    expect(() => parseSourceNamespaceInventory(providerMismatch)).toThrow();

    const invalidPath = inventory();
    invalidPath.projects[0] = { ...invalidPath.projects[0]!, path: "platform//payments-api" };
    expect(() => parseSourceNamespaceInventory(invalidPath)).toThrow();

    const siblingNamespace = inventory();
    siblingNamespace.projects[0] = {
      ...siblingNamespace.projects[0]!,
      path: "platform/product-tools/payments-api",
    };
    expect(() => parseSourceNamespaceInventory(siblingNamespace)).toThrow();

    const duplicate = inventory();
    duplicate.projectCount = { kind: "exact", value: 2 };
    duplicate.projects.push({ ...duplicate.projects[0]!, name: "payments-copy" });
    expect(() => parseSourceNamespaceInventory(duplicate)).toThrow();
  });

  test("rejects mismatched or unsafe provider details", () => {
    const providerMismatch = inventory();
    providerMismatch.projects[0] = {
      ...providerMismatch.projects[0]!,
      providerDetails: { provider: "bitbucket-server", scmId: "git" },
    };
    expect(() => parseSourceNamespaceInventory(providerMismatch)).toThrow(
      "must match the project provider",
    );

    const unsafeUrl = inventory();
    unsafeUrl.projects[0] = {
      ...unsafeUrl.projects[0]!,
      providerDetails: {
        provider: "gitlab",
        webUrl: "javascript:alert(1)",
      },
    };
    expect(() => parseSourceNamespaceInventory(unsafeUrl)).toThrow(
      "must be an HTTP(S) URL without credentials",
    );
  });

  test("rejects inventories outside the bounded provider envelope", () => {
    const value = inventory();
    value.projectCount = { kind: "at-least", value: MAX_SOURCE_INVENTORY_PROJECTS + 1 };
    value.projects = Array.from({ length: MAX_SOURCE_INVENTORY_PROJECTS + 1 }, (_, index) => ({
      ...value.projects[0]!,
      sourceId: String(index),
      path: `platform/products/project-${index}`,
      name: `project-${index}`,
    }));

    expect(() => parseSourceNamespaceInventory(value)).toThrow();
  });
});
