import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "ciConfiguration",
  order: 6,
  card: { label: "GitLab CI to convert", icon: "workflow", position: 7 },
});
