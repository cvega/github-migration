import { profileNumericObservationSchema } from "$lib/source/numeric-observation";
import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "containerRegistry",
  order: 17,
  card: { label: "Container repositories", icon: "package", position: 18 },
  fields: { tags: profileNumericObservationSchema },
});
