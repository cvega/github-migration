#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SEMANTIC_CONTRACTS } from "../../src/lib/server/semantic-contracts";
import {
  checkDurableTableInventory,
  checkSemanticDocument,
  GENERATED_SECTION_IDS,
  synchronizeSemanticDocument,
} from "./semantic-docs-lib";

const ROOT = resolve(import.meta.dir, "../..");
const architecturePath = resolve(ROOT, "docs/architecture.md");
const schemaPaths = [
  resolve(ROOT, "src/lib/server/migrate/database/schema.ts"),
  resolve(ROOT, "src/lib/server/profile/database/schema.ts"),
];
const mode = process.argv[2];

if (mode !== "--check" && mode !== "--write") {
  console.error("Usage: bun scripts/docs/semantic-docs.ts --check|--write");
  process.exit(2);
}

const document = await readFile(architecturePath, "utf8");
const schemaSources = await Promise.all(schemaPaths.map((path) => readFile(path, "utf8")));
const inventoryErrors = checkDurableTableInventory(schemaSources, SEMANTIC_CONTRACTS);
if (inventoryErrors.length > 0) {
  console.error(inventoryErrors.join("\n"));
  process.exit(1);
}

if (mode === "--write") {
  await writeFile(
    architecturePath,
    synchronizeSemanticDocument(document, SEMANTIC_CONTRACTS),
    "utf8",
  );
  console.log(`Updated ${GENERATED_SECTION_IDS.length} semantic documentation sections`);
} else {
  const errors = checkSemanticDocument(document, SEMANTIC_CONTRACTS);
  if (errors.length > 0) {
    console.error(`${errors.join("\n")}\nRun 'bun run docs:sync' to update generated sections.`);
    process.exit(1);
  }
  console.log(`Semantic documentation check passed: ${GENERATED_SECTION_IDS.length} sections`);
}
