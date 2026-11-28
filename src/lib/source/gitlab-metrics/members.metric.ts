import { z } from "zod";
import { profileNumericObservationSchema } from "$lib/source/numeric-observation";
import { defineGitLabMetric } from "./define";

const memberCountSchema = z
  .object({
    provider: z.literal("gitlab"),
    endpointFamily: z.string().min(1).max(255),
    collectedAt: z.string().datetime({ offset: true }),
    observation: profileNumericObservationSchema,
  })
  .strict();
export const gitLabMembershipScopeSchema = z
  .object({
    kind: z.enum(["project", "group"]),
    path: z.string().min(1).max(2_048),
    direct: memberCountSchema,
    effective: memberCountSchema,
  })
  .strict();
export type GitLabMembershipScope = z.infer<typeof gitLabMembershipScopeSchema>;

export default defineGitLabMetric({
  key: "members",
  order: 15,
  card: { label: "Scoped membership", icon: "people", position: 16 },
  fields: { scopes: z.array(gitLabMembershipScopeSchema).max(2) },
});
