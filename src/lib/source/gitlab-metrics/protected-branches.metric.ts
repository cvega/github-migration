import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "protectedBranches",
  order: 7,
  card: { label: "Branch protection rules", icon: "shield-lock", position: 8 },
  protectionRule: true,
});
