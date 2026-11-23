import type { BitbucketGhesTargetExecutionConfig } from "$lib/server/core/ghes-target";
import { type DockerExporterDependencies, DockerExporterWorker } from "./docker";

function bitbucketBaseUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  const suffix = "/rest/api/1.0";
  if (!url.pathname.endsWith(suffix)) {
    throw new TypeError("Bitbucket source API URL is invalid for bbs-exporter");
  }
  url.pathname = url.pathname.slice(0, -suffix.length) || "/";
  return url.toString().replace(/\/$/, "");
}

export class BitbucketExporterWorker extends DockerExporterWorker {
  constructor(
    config: BitbucketGhesTargetExecutionConfig,
    dependencies?: DockerExporterDependencies,
  ) {
    super(
      config,
      {
        provider: "bitbucket-server",
        jobPrefix: "gh-migrate-bbs",
        displayName: "bbs-exporter",
        validate(request) {
          if (request.lockSource) {
            throw new TypeError("bbs-exporter does not support source locking");
          }
        },
        command: (request, output) => ({
          environment: [
            `BITBUCKET_SERVER_URL=${bitbucketBaseUrl(request.sourceApiUrl)}`,
            `BITBUCKET_SERVER_API_USERNAME=${config.bitbucketUsername}`,
            `BITBUCKET_SERVER_API_PASSWORD=${config.bitbucketPassword}`,
          ],
          arguments: [
            "bbs-exporter",
            "--repository",
            `${request.sourceOrg}/${request.sourceRepo}`,
            "--except",
            "releases",
            "--out-file",
            output,
            "--no-progress-bar",
            "--no-color",
          ],
        }),
      },
      dependencies,
    );
  }
}
