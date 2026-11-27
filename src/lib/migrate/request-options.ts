import { z } from "zod";

const persistedRequestOptionsSchema = z
  .object({
    sourceApiUrl: z.string().optional(),
    sourceRepo: z.string().optional(),
    targetProfileId: z.string().optional(),
    targetOrg: z.string().optional(),
    targetRepo: z.string().optional(),
    noSslVerify: z.boolean().optional(),
    skipReleases: z.boolean().optional(),
    lockSource: z.boolean().optional(),
    archiveSource: z.boolean().optional(),
    targetRepoVisibility: z.enum(["private", "public", "internal"]).optional(),
    directPassthrough: z.boolean().optional(),
  })
  .strict();

type PersistedRequestOptions = z.infer<typeof persistedRequestOptionsSchema>;

export function parsePersistedRequestOptions(json: string): PersistedRequestOptions {
  try {
    return persistedRequestOptionsSchema.parse(JSON.parse(json));
  } catch (cause) {
    throw new Error("Invalid stored migration request options", { cause });
  }
}

export function tryParsePersistedRequestOptions(
  json: string | null,
): PersistedRequestOptions | null {
  if (!json) return null;
  try {
    return parsePersistedRequestOptions(json);
  } catch {
    return null;
  }
}
