/** Shared formatting utilities used by both server and frontend code. */

export function formatElapsed(seconds: number | null, fallback = "—"): string {
  if (seconds == null) return fallback;
  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

export function formatHours(hours: number | null, fallback = "—"): string {
  if (hours == null || hours <= 0) return fallback;
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (wholeHours < 24) return minutes > 0 ? `${wholeHours}h ${minutes}m` : `${wholeHours}h`;
  const days = Math.floor(wholeHours / 24);
  const remainingHours = wholeHours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function formatRepoSize(kilobytes: number | null | undefined, fallback = "—"): string {
  if (kilobytes == null) return fallback;
  if (kilobytes < 1024) return `${kilobytes} KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) {
    return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
  }
  const gigabytes = megabytes / 1024;
  return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
}

export function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function timeAgo(iso: string): string {
  const difference = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
