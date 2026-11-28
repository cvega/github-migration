import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "issues",
  order: 0,
  card: { label: "Visible issues", icon: "issue-opened", position: 5 },
});
