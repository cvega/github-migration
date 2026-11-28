import { z } from "zod";
import { defineGitLabMetric } from "./define";

export const gitLabPackageEcosystemSchema = z.enum([
  "composer",
  "conan",
  "debian",
  "generic",
  "golang",
  "helm",
  "maven",
  "ml_model",
  "npm",
  "nuget",
  "pypi",
  "rpm",
  "rubygems",
  "swift",
  "terraform_module",
  "other",
]);

export default defineGitLabMetric({
  key: "packageVersions",
  order: 18,
  card: { label: "Package versions to republish", icon: "package", position: 19 },
  fields: {
    ecosystemCounts: z
      .partialRecord(gitLabPackageEcosystemSchema, z.int().nonnegative())
      .nullable(),
  },
});
