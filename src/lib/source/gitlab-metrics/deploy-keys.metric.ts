import { z } from "zod";
import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "deployKeys",
  order: 19,
  card: { label: "Deploy keys", icon: "key", position: 20 },
  fields: {
    readOnlyCount: z.int().nonnegative().nullable(),
    pushCapableCount: z.int().nonnegative().nullable(),
  },
});
