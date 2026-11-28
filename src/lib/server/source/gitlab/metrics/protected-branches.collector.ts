import descriptor from "$lib/source/gitlab-metrics/protected-branches.metric";
import { collectGitLabProtectedBranchMetric } from "../protections";
import { defineGitLabCollector } from "./types";

export default defineGitLabCollector(descriptor, collectGitLabProtectedBranchMetric);
