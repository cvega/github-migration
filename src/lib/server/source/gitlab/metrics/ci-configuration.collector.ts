import descriptor from "$lib/source/gitlab-metrics/ci-configuration.metric";
import { collectGitLabCiConfigurationMetric } from "../ci-configuration";
import { defineGitLabCollector } from "./types";

export default defineGitLabCollector(descriptor, collectGitLabCiConfigurationMetric);
