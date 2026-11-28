import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "inheritedProtectedBranches",
  order: 8,
  card: { label: "Inherited branch rules", icon: "shield", position: 9 },
  protectionRule: true,
});
