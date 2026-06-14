#!/usr/bin/env bun
/**
 * release:prep — bump the version for the next release.
 *
 * Computes the next semantic version from the Conventional Commits since the
 * last tag (via git-cliff: a breaking change → major, a feat → minor, anything
 * else → patch), writes it to package.json, and regenerates CHANGELOG.md so the
 * unreleased commits are filed under the new version.
 *
 * It deliberately stops there — it does NOT commit, tag, or push. Review the
 * diff, then land it as a normal `chore(release): <version>` PR; pushing the
 * matching `vX.Y.Z` tag is what triggers release.yml. This keeps the human gate
 * before a release while removing the hand-editing that used to set the version.
 *
 *   bun run release:prep
 */
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const gitCliff = new URL("../node_modules/.bin/git-cliff", import.meta.url).pathname;
const configPath = new URL("../cliff.toml", import.meta.url).pathname;
const pkgPath = new URL("../package.json", import.meta.url).pathname;

/** Run git-cliff with the repo config; throws (with stderr) on failure. */
async function cliff(...args: string[]): Promise<string> {
  const result = await $`${gitCliff} --config ${configPath} ${args}`.cwd(root).quiet().nothrow();
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr.toString());
    throw new Error(`git-cliff ${args.join(" ")} failed (exit ${result.exitCode})`);
  }
  return result.stdout.toString().trim();
}

// The version git-cliff assigns to the unreleased commits (e.g. "v0.0.4"), and
// the most recent release tag we'd be bumping from.
const bumped = await cliff("--bumped-version");
const nextVersion = bumped.replace(/^v/, "");
const lastTag = (await $`git describe --tags --abbrev=0`.cwd(root).quiet().nothrow()).stdout
  .toString()
  .trim();

// git-cliff returns the last tag unchanged when there are no releasable commits.
if (lastTag && bumped === lastTag) {
  console.log(`No releasable commits since ${lastTag} — nothing to bump.`);
  process.exit(0);
}

// Edit only the version line so Biome's formatting (the `format` gate) is left
// untouched — a full JSON re-serialize would risk reformatting the file.
const pkgRaw = await Bun.file(pkgPath).text();
const current = pkgRaw.match(/"version":\s*"([^"]+)"/)?.[1] ?? "(unknown)";
if (current === nextVersion) {
  console.log(`package.json is already at ${nextVersion} — nothing to bump.`);
  process.exit(0);
}
await Bun.write(pkgPath, pkgRaw.replace(/("version":\s*)"[^"]+"/, `$1"${nextVersion}"`));

// Regenerate the changelog with the unreleased section under the new version.
await cliff("--bump", "--output", "CHANGELOG.md");

console.log(`Bumped ${current} → ${nextVersion}  (updated package.json + CHANGELOG.md)`);
console.log("");
console.log("Next:");
console.log("  1. Review the diff");
console.log(`  2. Commit:  git commit -am "chore(release): ${nextVersion}"`);
console.log("  3. Open a PR and merge it");
console.log(`  4. Tag:     git tag v${nextVersion} && git push origin v${nextVersion}`);
console.log("     (the tag triggers release.yml: build → scan → draft release → changelog)");
