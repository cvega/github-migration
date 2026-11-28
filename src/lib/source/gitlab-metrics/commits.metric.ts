import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "commits",
  order: 2,
  card: { label: "Commits", icon: "git-commit", position: 0 },
});
