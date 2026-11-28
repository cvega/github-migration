import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "branches",
  order: 3,
  card: { label: "Branches", icon: "git-branch", position: 2 },
});
