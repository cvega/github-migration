import { invalidateAll } from "$app/navigation";

/** Reload the page through the normal grant check, with at most one poll in flight. */
export function pollScopedPage() {
  let stopped = false;
  let timer = setTimeout(poll, 5000);
  async function poll() {
    try {
      if (!document.hidden) await invalidateAll();
    } finally {
      if (!stopped) timer = setTimeout(poll, 5000);
    }
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
