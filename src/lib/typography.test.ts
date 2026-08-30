import { describe, expect, test } from "bun:test";

const typographySourceFiles = [new Bun.Glob("src/**/*.svelte"), new Bun.Glob("src/**/*.css")];

describe("typography system", () => {
  test("keeps production text at or above the 13px meta role", async () => {
    const violations: string[] = [];

    for (const sourceFiles of typographySourceFiles) {
      for await (const file of sourceFiles.scan({ cwd: process.cwd() })) {
        const source = await Bun.file(file).text();
        const utilityMatches = source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g);
        const cssMatches = source.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g);

        for (const match of [...utilityMatches, ...cssMatches]) {
          if (Number(match[1]) < 13) {
            violations.push(`${file}: ${match[0]}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("defines Mona Sans interface and machine roles", async () => {
    const stylesheet = await Bun.file("src/app.css").text();

    expect(stylesheet).toContain('--font-sans: "Mona Sans"');
    expect(stylesheet).toContain('--font-mono: "Mona Sans Mono"');
    expect(stylesheet).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(stylesheet).toMatch(
      /\.text-machine\s*\{[^}]*font-size:\s*0\.875rem;[^}]*line-height:\s*1\.25rem;/s,
    );
  });
});
