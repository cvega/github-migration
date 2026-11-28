import descriptor from "$lib/source/gitlab-metrics/group-webhooks.metric";
import { collectGitLabGroupWebhookMetric } from "../webhooks";
import { defineGitLabCollector } from "./types";

export default defineGitLabCollector(descriptor, collectGitLabGroupWebhookMetric);
