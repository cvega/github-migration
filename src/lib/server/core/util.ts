/**
 * Shared utility: cancellable sleep with AbortSignal support.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Extract org from "org/repo" format — returns whole string if no slash. */
export function extractOrg(repoSlug: string): string {
  const idx = repoSlug.indexOf("/");
  return idx > 0 ? repoSlug.substring(0, idx) : idx === 0 ? "" : repoSlug;
}

/** Extract repo name from "org/repo" format. */
export function extractRepo(repoSlug: string): string {
  const idx = repoSlug.indexOf("/");
  return idx > 0 ? repoSlug.substring(idx + 1) : idx === 0 ? repoSlug.substring(1) : repoSlug;
}
