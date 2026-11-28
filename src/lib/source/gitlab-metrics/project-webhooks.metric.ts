import { gitLabWebhookEventCategoriesSchema } from "$lib/source/gitlab-webhooks";
import { defineGitLabMetric } from "./define";

export default defineGitLabMetric({
  key: "projectWebhooks",
  order: 10,
  card: { label: "Project webhooks", icon: "webhook", position: 11 },
  fields: { eventCategories: gitLabWebhookEventCategoriesSchema },
});
