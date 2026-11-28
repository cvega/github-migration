import { z } from "zod";
import { defineGitLabMetric } from "./define";

const pullMirrorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["enabled", "disabled", "not-mirrored"]) }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum(["forbidden", "not-reported", "malformed", "request-budget"]),
    })
    .strict(),
]);

export default defineGitLabMetric({
  key: "mirrors",
  order: 16,
  card: { label: "Enabled push mirrors", icon: "sync", position: 17 },
  fields: {
    hasDisabledPushMirrors: z.boolean().nullable(),
    pullMirror: pullMirrorSchema,
  },
});
