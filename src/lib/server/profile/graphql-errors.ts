/**
 * Shared classification of GitHub GraphQL transport errors.
 *
 * The crawl makes many GraphQL requests (discovery pages, counts chunks, detail
 * chunks). GitHub aborts any single request that takes longer than ~10s and
 * responds with a 502 or 504 (sometimes an nginx HTML body, sometimes a
 * "Something went wrong while executing your query" message). Every pass treats
 * that the same way — make the request cheaper and retry (split a chunk, or
 * shrink a discovery page) — so the predicate lives here, used by both
 * `discover.ts` (page-size shrink) and `augment.ts` (chunk split).
 */

/**
 * Whether an error is a GitHub processing timeout (the request was too
 * expensive to evaluate in GitHub's ~10s window). These carry no usable partial
 * data; the remedy is always to make the query cheaper and retry.
 */
export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; message?: string };
  if (e.status === 502 || e.status === 504) return true;
  return (
    typeof e.message === "string" &&
    /timeout|timed out|executing your query|respond to your request in time/i.test(e.message)
  );
}

/**
 * Recover the partial `data` from a GraphQL error that carries it, else null.
 *
 * Octokit throws a `GraphqlResponseError` whenever a response has any `errors`,
 * even when it also returned usable `data` — e.g. a field the token can't read
 * resolves to `null` and adds an error, but its siblings come back fine. The
 * crawl prefers that partial data over failing the whole request, so this
 * duck-types the carried `data` off the thrown error. Used by `augment.ts`
 * (a repo alias the token can't read) and `enterprise.ts` (an org in the
 * enterprise that forbids the token).
 */
export function partialDataFromError(err: unknown): Record<string, unknown> | null {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") return data as Record<string, unknown>;
  }
  return null;
}
