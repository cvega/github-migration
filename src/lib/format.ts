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
  if (!seconds) return fallback;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
