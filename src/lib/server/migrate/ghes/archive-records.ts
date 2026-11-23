import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { stringify } from "csv-stringify/sync";
import { extract } from "tar-stream";

const models = {
  organizations: "organization",
  repositories: "repository",
  users: "user",
  teams: "team",
} as const;

/** Read only this export's root mapping manifests; never extract or buffer Git objects. */
export async function bitbucketArchiveRecords(path: string, signal?: AbortSignal): Promise<string> {
  const tar = extract();
  const rows: { model_name: string; source_url: string; target_url: string; state: string }[] = [];
  let total = 0;
  const parse = async () => {
    for await (const entry of tar) {
      const name = /^(?:\.\/)?(organizations|repositories|users|teams)_\d+\.json$/.exec(
        entry.header.name,
      )?.[1];
      if (!name) {
        entry.resume();
        continue;
      }
      total += entry.header.size;
      if (
        entry.header.type !== "file" ||
        entry.header.size > 8 * 1024 ** 2 ||
        total > 64 * 1024 ** 2
      )
        throw new Error("Unsupported Bitbucket mapping manifest size or type");
      const chunks: Buffer[] = [];
      for await (const chunk of entry) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected non-binary archive data");
        chunks.push(chunk);
      }
      const manifest: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(manifest)) throw new Error("Invalid Bitbucket mapping manifest");
      for (const item of manifest) {
        if (typeof item?.url !== "string" || !URL.canParse(item.url))
          throw new Error("Missing source URL in Bitbucket mapping manifest");
        rows.push({
          model_name: models[name as keyof typeof models],
          source_url: item.url,
          target_url: "",
          state: "exported",
        });
      }
    }
  };
  await Promise.all([
    pipeline(createReadStream(path), createGunzip(), tar, { signal }),
    parse().catch((error) => {
      tar.destroy(error);
      throw error;
    }),
  ]);
  for (const type of ["organization", "repository"])
    if (rows.filter((row) => row.model_name === type).length !== 1)
      throw new Error(`Expected one Bitbucket ${type} in mapping manifests`);
  return stringify(rows, { header: true });
}
