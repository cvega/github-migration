import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "releases",
  order: 5,
  card: { label: "Releases", icon: "package", position: 4 },
});
