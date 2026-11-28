import { profileNumericObservationSchema } from "$lib/source/numeric-observation";
import { defineGitLabMetric } from "./define";

/**
 * CI/CD variable entries, counted from pagination headers only. The numeric
 * observation is the project-local count; `groupLocal` is the separate count of
 * entries configured on the admitted ancestor groups. Names, values and
 * environment scopes are never requested, so none can be stored.
 */
export default defineGitLabMetric({
  key: "ciVariables",
  order: 13,
  card: { label: "Project CI/CD variables", icon: "key", position: 14 },
  fields: { groupLocal: profileNumericObservationSchema },
});
