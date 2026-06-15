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
 * Format a duration given in hours as a coarse, human-readable string for
 * estimates: minutes under an hour, `Hh Mm` under a day, `Dd Hh` beyond.
 *
 * @param hours - Duration in hours (may be fractional), or null/≤0.
 * @param fallback - String to return when hours is null/≤0 (default "—").
 */
export function formatHours(hours: number | null, fallback = "—"): string {
  if (hours == null || hours <= 0) return fallback;
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
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

/**
 * Format a timestamp as a compact relative age, e.g. "just now", "5m ago",
 * "3h ago", "2d ago".
 *
 * @param iso - ISO 8601 timestamp.
 */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
