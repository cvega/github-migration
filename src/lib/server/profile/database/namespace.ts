/** Match one literal repository segment, never descendants or LIKE patterns. */
export function repositoryNamespace(column: string, namespace?: string) {
  if (namespace === undefined) return { sql: "", params: {} as Record<string, string> };
  const leaf = `substr(${column}, length($prefix) + 1)`;
  return {
    sql: ` AND substr(${column}, 1, length($prefix)) = $prefix COLLATE BINARY
      AND ${leaf} NOT IN ('', '.', '..') AND instr(${leaf}, '/') = 0`,
    params: { $prefix: `${namespace}/` },
  };
}
