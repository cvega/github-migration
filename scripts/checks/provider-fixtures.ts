import { z } from "zod";
import { bitbucketComposeFile } from "../../tests/providers/bitbucket/live";
import { gitlabComposeFile } from "../../tests/providers/gitlab/live";

const service = z.object({
  image: z.string().regex(/@sha256:[0-9a-f]{64}$/),
  healthcheck: z.object({ test: z.array(z.string()).min(1) }),
});

for (const [provider, path] of [
  ["bitbucket", bitbucketComposeFile],
  ["gitlab", gitlabComposeFile],
] as const) {
  const manifest = z.object({ services: z.record(z.string(), service) });
  const { services } = manifest.parse(Bun.YAML.parse(await Bun.file(path).text()));
  if (!services[provider]) throw new Error(`${path}: missing ${provider} service`);
}
console.log("[provider-fixtures] Live contract modules and Compose inputs are available");
