import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimedRepositoryAnalysisJob } from "../database/repository-analysis-jobs";
import {
  analyzeRepository,
  type RepositoryAnalyzerDependencies,
  runAnalyzerCommand,
} from "./analyze-repository";

const job: ClaimedRepositoryAnalysisJob = {
  id: "job",
  analysisRunId: "analysis",
  profileRunId: "profile",
  profileRepoId: 7,
  nameWithOwner: "acme/widgets",
  sourceApiUrl: "https://api.github.com",
  attempt: 1,
  estimatedWorkspaceBytes: 2_000,
};

function dependencies(commands: string[][]): RepositoryAnalyzerDependencies {
  return {
    run: async (command) => {
      commands.push(command);
      const joined = command.join(" ");
      if (joined.includes("git-sizer --json"))
        return { exitCode: 0, stdout: '{"version":2}', stderr: "" };
      if (joined.includes("lfs ls-files"))
        return {
          exitCode: 0,
          stdout:
            '{"files":[{"oid_type":"sha256","oid":"a","name":"a.bin","size":10},{"oid_type":"sha256","oid":"a","name":"copy.bin","size":10}]}',
          stderr: "",
        };
      if (joined.includes("for-each-ref"))
        return { exitCode: 0, stdout: "refs/heads/main abc", stderr: "" };
      if (joined === "du -sk .") return { exitCode: 0, stdout: "42\t.", stderr: "" };
      if (joined === "git --version")
        return { exitCode: 0, stdout: "git version 2.43.0", stderr: "" };
      if (joined === "git lfs version") return { exitCode: 0, stdout: "git-lfs/3.4.1", stderr: "" };
      if (joined === "git-sizer --version")
        return { exitCode: 0, stdout: "git-sizer release 1.5.0", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    mkdir: async () => {},
    remove: async () => {},
    workspaceCapacity: async () => ({ capacityBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }),
    getSourceToken: async () => "secret-token",
  };
}

describe("repository analyzer", () => {
  test("captures output from a real analyzer subprocess", async () => {
    const result = await runAnalyzerCommand(
      [process.execPath, "-e", 'console.log("result"); console.error("detail")'],
      { timeoutMs: 1_000 },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "result\n", stderr: "detail\n" });
  });

  test("rejects analyzer subprocess output above its safety limit", async () => {
    await expect(
      runAnalyzerCommand([process.execPath, "-e", 'process.stdout.write("x".repeat(600 * 1024))'], {
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Analyzer command output exceeded 512 KiB");
  });

  test("runs a credential-safe mirror analysis and normalizes LFS pointers", async () => {
    const commands: string[][] = [];
    const result = await analyzeRepository(
      job,
      { workspaceRoot: "/analysis" },
      dependencies(commands),
    );
    expect(commands[0]).toEqual([
      "git",
      "clone",
      "--mirror",
      "https://github.com/acme/widgets.git",
      "/analysis/analysis/7/1/mirror.git",
    ]);
    expect(commands.flat().join(" ")).not.toContain("secret-token");
    expect(result).toMatchObject({
      mirrorSizeBytes: 42 * 1024,
      gitSizerVersion: "git-sizer release 1.5.0",
      lfsPointers: [{ oid: "sha256:a", declaredSizeBytes: 10, representativePath: "a.bin" }],
    });
  });

  test("rejects a job that cannot fit above the filesystem reserve", async () => {
    const deps = dependencies([]);
    deps.workspaceCapacity = async () => ({
      capacityBytes: 10 * 1024 ** 3,
      freeBytes: 5 * 1024 ** 3,
    });
    await expect(analyzeRepository(job, { workspaceRoot: "/analysis" }, deps)).rejects.toThrow(
      "insufficient_workspace",
    );
  });

  test("uses the default workspace lifecycle and removes repository data", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "gh-migrate-analysis-"));
    const commandDeps = dependencies([]);
    try {
      await analyzeRepository(
        job,
        { workspaceRoot },
        { run: commandDeps.run, getSourceToken: commandDeps.getSourceToken },
      );

      await expect(access(join(workspaceRoot, "analysis", "7", "1"))).rejects.toThrow();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reports command failures and removes the attempted workspace", async () => {
    const removed: string[] = [];
    const deps = dependencies([]);
    deps.run = async () => ({ exitCode: 128, stdout: "", stderr: "private provider diagnostic" });
    deps.remove = async (path) => {
      removed.push(path);
    };

    await expect(analyzeRepository(job, { workspaceRoot: "/analysis" }, deps)).rejects.toThrow(
      /^Git mirror clone failed \(exit code 128\)$/,
    );
    expect(removed).toEqual(["/analysis/analysis/7/1", "/analysis/analysis/7/1"]);
  });

  test("does not publish an incomplete LFS inventory as zero pointers", async () => {
    const deps = dependencies([]);
    const baseRun = deps.run;
    deps.run = async (command, options) =>
      command.includes("ls-files")
        ? { exitCode: 0, stdout: '{"files":[{"size":10}]}', stderr: "" }
        : baseRun(command, options);
    await expect(analyzeRepository(job, { workspaceRoot: "/analysis" }, deps)).rejects.toThrow(
      "invalid pointer inventory",
    );
  });

  test("rejects malformed command output and removes the workspace", async () => {
    const removed: string[] = [];
    const deps = dependencies([]);
    const baseRun = deps.run;
    deps.run = async (command, options) => {
      if (command.join(" ") === "du -sk .") {
        return { exitCode: 0, stdout: "unknown\t.", stderr: "" };
      }
      return baseRun(command, options);
    };
    deps.remove = async (path) => {
      removed.push(path);
    };

    await expect(analyzeRepository(job, { workspaceRoot: "/analysis" }, deps)).rejects.toThrow(
      "Unable to determine mirror workspace size",
    );
    expect(removed).toHaveLength(2);
  });
});
