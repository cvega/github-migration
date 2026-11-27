import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const classifier = join(import.meta.dir, "docs-only.sh");

test("verification takes the full path unless the classifier confirms docs-only", async () => {
  const workflow = await Bun.file(
    join(import.meta.dir, "../../.github/workflows/verify.yml"),
  ).text();
  type Step = { id?: string; name?: string; if?: string };
  const { jobs } = Bun.YAML.parse(workflow) as {
    jobs: { gates: { steps: Step[] }; e2e: { steps: Step[] } };
  };
  const fullPath = "steps.paths.outputs.docs_only != 'true'";
  for (const name of ["Validate GitHub Actions workflows", "Run repository gates"]) {
    expect(jobs.gates.steps.find((step) => step.name === name)?.if, name).toBe(fullPath);
  }
  expect(
    jobs.gates.steps.find((step) => step.name === "Run documentation and formatting gates")?.if,
  ).toBe("steps.paths.outputs.docs_only == 'true'");

  const classifierIndex = jobs.e2e.steps.findIndex((step) => step.id === "paths");
  expect(classifierIndex).toBeGreaterThanOrEqual(0);
  const browserSteps = jobs.e2e.steps.slice(classifierIndex + 1);
  expect(browserSteps.some((step) => step.name === "Run browser gate")).toBe(true);
  for (const step of browserSteps) {
    const condition =
      step.name === "Upload browser failure traces" ? `failure() && ${fullPath}` : fullPath;
    expect(step.if, step.name).toBe(condition);
  }
});

test("only pull requests with exclusively documentation changes take the fast path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "docs-only-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const write = (path: string, content: string) => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const classify = (event: string, base: string, head: string) =>
    Bun.spawnSync(["bash", classifier, event, base, head], { cwd });
  const expectClassification = (event: string, base: string, head: string, docsOnly: boolean) => {
    const result = classify(event, base, head);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe(`docs_only=${docsOnly}`);
  };

  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    write("src/example.ts", "export const value = 0;\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");

    write("AGENTS.md", "# Agent notes\n");
    git("add", ".");
    git("commit", "-qm", "agents only");
    expectClassification("pull_request", base, "HEAD", true);

    write(".github/notes.md", "# Nested Markdown\n");
    write("docs/nested/diagram.svg", "<svg />\n");
    git("add", ".");
    git("commit", "-qm", "more docs");
    expectClassification("pull_request", base, "HEAD", true);
    expectClassification("push", "", "", false);
    expectClassification("workflow_dispatch", "", "", false);
    expectClassification("pull_request", "HEAD", "HEAD", false);
    expect(classify("pull_request", "missing-base", "HEAD").exitCode).not.toBe(0);

    const docsHead = git("rev-parse", "HEAD");
    write("src/example.ts", "export const value = 1;\n");
    git("add", ".");
    git("commit", "-qm", "code");
    expectClassification("pull_request", docsHead, "HEAD", false);
    expectClassification("pull_request", base, "HEAD", false);

    const codeHead = git("rev-parse", "HEAD");
    renameSync(join(cwd, "src/example.ts"), join(cwd, "docs/example.ts"));
    git("add", "-A");
    git("commit", "-qm", "move code into docs");
    expectClassification("pull_request", codeHead, "HEAD", false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
