/**
 * Shared formatting utilities used by both server and frontend code.
 */

/**
 * Format a duration in seconds as a human-readable string.
 * Handles hours, minutes, and seconds.
 *
 * @param seconds - Duration in seconds, or null/0.
 * @param fallback - String to return when seconds is null/0 (default "—").
 */
export function formatElapsed(seconds: number | null, fallback = "—"): string {
  if (seconds == null) return fallback;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Format a repository size given in kilobytes as a human-readable string
 * (KB / MB / GB). Mirrors the GitHub API's `size` field, which is in KB.
 *
 * @param kb - Size in kilobytes, or null/undefined.
 * @param fallback - String to return when kb is null/undefined (default "—").
 */
export function formatRepoSize(kb: number | null | undefined, fallback = "—"): string {
  if (kb == null) return fallback;
  if (kb < 1024) return `${kb} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

/**
 * Format an ISO timestamp as a short, human-readable local date + time,
 * e.g. "Jun 8, 2026, 3:42 PM".
 *
 * @param iso - ISO 8601 timestamp, or null/undefined.
 * @param fallback - String to return when iso is null/undefined (default "—").
 */
export function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
