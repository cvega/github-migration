import descriptor from "$lib/source/gitlab-metrics/project-webhooks.metric";
import { collectGitLabProjectWebhookMetric } from "../webhooks";
import { defineGitLabCollector } from "./types";

export default defineGitLabCollector(descriptor, collectGitLabProjectWebhookMetric);
