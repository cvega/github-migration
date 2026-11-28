import { gitLabWebhookEventCategoriesSchema } from "$lib/source/gitlab-webhooks";
import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "groupWebhooks",
  order: 11,
  card: { label: "Group hooks", icon: "webhook", position: 12 },
  fields: { eventCategories: gitLabWebhookEventCategoriesSchema },
});
