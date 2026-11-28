import descriptor from "$lib/source/gitlab-metrics/inherited-protected-branches.metric";
import { collectGitLabInheritedProtectedBranchMetric } from "../protections";
import { defineGitLabCollector } from "./types";

export default defineGitLabCollector(descriptor, collectGitLabInheritedProtectedBranchMetric);
