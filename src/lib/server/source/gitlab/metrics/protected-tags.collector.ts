import descriptor from "$lib/source/gitlab-metrics/protected-tags.metric";
import { collectGitLabProtectedTagMetric } from "../protections";
import { defineGitLabCollector } from "./types";

export default defineGitLabCollector(descriptor, collectGitLabProtectedTagMetric);
