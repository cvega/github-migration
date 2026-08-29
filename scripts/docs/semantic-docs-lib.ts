import type { SemanticContracts } from "../../src/lib/server/semantic-contracts";

export const GENERATED_SECTION_IDS = [
  "support-matrix",
  "migration-lifecycle",
  "ghes-import-phases",
  "durable-tables",
] as const;

type GeneratedSectionId = (typeof GENERATED_SECTION_IDS)[number];

function marker(id: GeneratedSectionId, edge: "BEGIN" | "END"): string {
  return `<!-- ${edge} GENERATED: ${id} -->`;
}

function codeList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

function renderSections(contracts: SemanticContracts): Record<GeneratedSectionId, string> {
  return {
    "support-matrix": [
      "| Source | Target | Executor |",
      "|---|---|---|",
      ...contracts.routes.map(
        (route) =>
          `| ${route.sourceDisplayName} | ${route.targetDisplayName} | ${route.executor ? `\`${route.executor}\`` : "Not supported"} |`,
      ),
    ].join("\n"),
    "migration-lifecycle": [
      `**Migration states:** ${codeList(contracts.migrationStates)}.`,
      "",
      `**GHEC observation phases:** ${codeList(contracts.migrationPhases)}.`,
    ].join("\n"),
    "ghes-import-phases": `**GHES import phases:** ${codeList(contracts.ghesImportPhases)}.`,
    "durable-tables": [
      "| Table | Purpose | Notes |",
      "|---|---|---|",
      ...contracts.durableTables.map(
        (table) => `| \`${table.name}\` | ${table.purpose} | ${table.notes} |`,
      ),
    ].join("\n"),
  };
}

function replaceSection(document: string, id: GeneratedSectionId, content: string): string {
  const start = marker(id, "BEGIN");
  const end = marker(id, "END");
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex || document.indexOf(start, startIndex + 1) >= 0) {
    throw new Error(`Missing or duplicate generated documentation markers for '${id}'`);
  }
  const afterEnd = endIndex + end.length;
  return `${document.slice(0, startIndex)}${start}\n${content}\n${end}${document.slice(afterEnd)}`;
}

export function synchronizeSemanticDocument(
  document: string,
  contracts: SemanticContracts,
): string {
  const sections = renderSections(contracts);
  return GENERATED_SECTION_IDS.reduce(
    (current, id) => replaceSection(current, id, sections[id]),
    document,
  );
}

export function checkSemanticDocument(document: string, contracts: SemanticContracts): string[] {
  const sections = renderSections(contracts);
  const errors: string[] = [];
  for (const id of GENERATED_SECTION_IDS) {
    try {
      if (replaceSection(document, id, sections[id]) !== document) {
        errors.push(`Generated documentation section '${id}' is out of date`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

function extractCreatedTableNames(schemaSources: readonly string[]): string[] {
  return schemaSources
    .flatMap((source) =>
      Array.from(
        source.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z][a-z0-9_]*)/gi),
        (match) => match[1]?.toLowerCase() ?? "",
      ),
    )
    .filter(Boolean)
    .sort();
}

export function checkDurableTableInventory(
  schemaSources: readonly string[],
  contracts: SemanticContracts,
): string[] {
  const actual = extractCreatedTableNames(schemaSources);
  const documented = contracts.durableTables.map((table) => table.name).sort();
  return actual.join("\n") === documented.join("\n")
    ? []
    : [
        `Durable table contract mismatch: schema=[${actual.join(", ")}], contract=[${documented.join(", ")}]`,
      ];
}
