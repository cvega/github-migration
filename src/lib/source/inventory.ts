import { z } from "zod";
import type { SourceNamespaceInventory, SourceProjectInventory } from "$lib/source/types";
import {
  getSourceProviderAdapter,
  SOURCE_PROVIDERS,
  type SourceProvider,
} from "$lib/source-provider";
import { assertPersistableSourceApiUrl } from "./url";

export type {
  SourceInventoryProgress,
  SourceNamespaceInventory,
  SourceProjectInventory,
} from "$lib/source/types";

export const MAX_SOURCE_INVENTORY_PROJECTS = 10_000;

export function assertSourceInventoryProjectLimit(
  provider: SourceProvider,
  projectCount: number,
): void {
  const limit = getSourceProviderAdapter(provider).inventoryProjectLimit;
  if (limit === null) {
    throw new TypeError(`${provider} is not registered as an inventory provider`);
  }
  if (projectCount > limit) {
    throw new RangeError(`${provider} inventory exceeds the ${limit}-project collection limit`);
  }
}

const numericObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), value: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("at-least"), value: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum(["forbidden", "not-found-or-hidden", "not-reported"]),
    })
    .strict(),
]);

const optionalWebUrl = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }, "must be an HTTP(S) URL without credentials");

const sourceProjectProviderDetailsSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("gitlab"),
      webUrl: optionalWebUrl.optional(),
      description: z.string().max(10_000).nullable().optional(),
      topics: z.array(z.string().min(1).max(255)).max(100).optional(),
      emptyRepository: z.boolean().optional(),
      forkedFromPath: z.string().min(1).max(2_048).optional(),
      features: z
        .object({
          issues: z.boolean().optional(),
          mergeRequests: z.boolean().optional(),
          wiki: z.boolean().optional(),
          snippets: z.boolean().optional(),
          containerRegistry: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("bitbucket-server"),
      webUrl: optionalWebUrl.optional(),
      description: z.string().max(10_000).nullable().optional(),
      scmId: z.string().min(1).max(255).optional(),
      forkable: z.boolean().optional(),
      forkedFromPath: z.string().min(1).max(2_048).optional(),
      state: z.string().min(1).max(255).optional(),
    })
    .strict(),
]);

const sourceProjectInventorySchema = z
  .object({
    provider: z.enum(SOURCE_PROVIDERS),
    sourceId: z.string().min(1).max(255),
    path: z.string().min(1).max(2_048),
    name: z.string().min(1).max(255),
    visibility: z.enum(["public", "private", "internal"]),
    archived: z.boolean(),
    defaultBranch: z.string().max(255).nullable(),
    lastActivityAt: z.string().datetime({ offset: true }).nullable(),
    repositorySizeBytes: numericObservationSchema,
    storageSizeBytes: numericObservationSchema,
    lfsObjectsSizeBytes: numericObservationSchema,
    packagesSizeBytes: numericObservationSchema,
    wikiSizeBytes: numericObservationSchema,
    uploadsSizeBytes: numericObservationSchema,
    providerDetails: sourceProjectProviderDetailsSchema.optional(),
  })
  .strict();

const sourceNamespaceInventorySchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(SOURCE_PROVIDERS),
    sourceApiUrl: z.string().min(1).max(2_048),
    namespace: z.string().min(1).max(2_048),
    projectCount: numericObservationSchema,
    projects: z.array(sourceProjectInventorySchema).max(MAX_SOURCE_INVENTORY_PROJECTS),
  })
  .strict()
  .superRefine((inventory, context) => {
    const adapter = getSourceProviderAdapter(inventory.provider);
    try {
      assertPersistableSourceApiUrl(inventory.sourceApiUrl);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["sourceApiUrl"],
        message: "must be an HTTP(S) URL without credentials, query, or fragment",
      });
    }
    if (!adapter.isValidNamespace(inventory.namespace)) {
      context.addIssue({
        code: "custom",
        path: ["namespace"],
        message: "is not valid for the provider",
      });
    }
    if (
      adapter.inventoryProjectLimit === null ||
      inventory.projects.length > adapter.inventoryProjectLimit
    ) {
      context.addIssue({
        code: "custom",
        path: ["projects"],
        message: "exceeds the provider inventory project limit",
      });
    }
    if (
      inventory.projectCount.kind !== "unavailable" &&
      inventory.projectCount.value !== inventory.projects.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["projectCount"],
        message: "must equal the number of projects",
      });
    }
    if (inventory.projectCount.kind === "unavailable" && inventory.projects.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["projects"],
        message: "must be empty when the project count is unavailable",
      });
    }
    const sourceIds = new Set<string>();
    const paths = new Set<string>();
    for (const [index, project] of inventory.projects.entries()) {
      if (project.provider !== inventory.provider) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "provider"],
          message: "must match the inventory provider",
        });
      }
      if (project.providerDetails && project.providerDetails.provider !== project.provider) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "providerDetails", "provider"],
          message: "must match the project provider",
        });
      }
      if (!getSourceProviderAdapter(project.provider).isValidProjectPath(project.path)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "path"],
          message: "is not a valid project path for the provider",
        });
      }
      if (!adapter.isProjectInNamespace(project.path, inventory.namespace)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "path"],
          message: "must belong to the inventory namespace",
        });
      }
      if (sourceIds.has(project.sourceId) || paths.has(project.path)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index],
          message: "must have a unique sourceId and path",
        });
      }
      sourceIds.add(project.sourceId);
      paths.add(project.path);
    }
  });

export function parseSourceNamespaceInventory(value: unknown): SourceNamespaceInventory {
  return sourceNamespaceInventorySchema.parse(value) as SourceNamespaceInventory;
}

export function parseSourceProjectInventory(value: unknown): SourceProjectInventory {
  return sourceProjectInventorySchema.parse(value) as SourceProjectInventory;
}
