import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "mergeRequests",
  order: 1,
  card: { label: "Merge requests", icon: "git-pull-request", position: 1 },
});
