import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "protectedTags",
  order: 9,
  card: { label: "Tag protection rules", icon: "shield-lock", position: 10 },
  protectionRule: true,
});
