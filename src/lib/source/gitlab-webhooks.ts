import { z } from "zod";

export const GITLAB_WEBHOOK_EVENT_CATEGORIES = [
  "push",
  "tag-push",
  "issues",
  "confidential-issues",
  "note",
  "confidential-note",
  "merge-requests",
  "job",
  "pipeline",
  "wiki-page",
  "deployment",
  "releases",
  "feature-flag",
  "resource-access-token",
  "emoji",
  "repository-update",
  "member",
  "subgroup",
  "project",
] as const;

export type GitLabWebhookEventCategory = (typeof GITLAB_WEBHOOK_EVENT_CATEGORIES)[number];

export const gitLabWebhookEventCategoriesSchema = z
  .array(z.enum(GITLAB_WEBHOOK_EVENT_CATEGORIES))
  .max(GITLAB_WEBHOOK_EVENT_CATEGORIES.length)
  .refine((categories) => new Set(categories).size === categories.length);
