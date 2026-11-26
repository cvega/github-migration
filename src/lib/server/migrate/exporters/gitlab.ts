import type { GhesTargetExecutionConfig } from "$lib/server/core/ghes-target";
import {
  type DockerExporterConfig,
  type DockerExporterDependencies,
  DockerExporterWorker,
} from "./docker";

export class GitLabExporterWorker extends DockerExporterWorker {
  constructor(
    config: DockerExporterConfig &
      Pick<GhesTargetExecutionConfig, "gitlabUsername" | "gitlabToken">,
    dependencies?: DockerExporterDependencies,
  ) {
    super(
      config,
      {
        provider: "gitlab",
        jobPrefix: "gh-migrate-gl",
        displayName: "gl-exporter",
        command: (request, output) => ({
          environment: [
            `GITLAB_API_ENDPOINT=${request.sourceApiUrl}`,
            `GITLAB_USERNAME=${config.gitlabUsername}`,
            `GITLAB_API_PRIVATE_TOKEN=${config.gitlabToken}`,
          ],
          arguments: [
            "gl_exporter",
            "--namespace",
            request.sourceOrg,
            "--project",
            request.sourceRepo,
            "--out-file",
            output,
            `--lock-projects=${request.lockSource ? "true" : "false"}`,
          ],
        }),
      },
      dependencies,
    );
  }
}
