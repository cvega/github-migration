// Reject parameterized links entirely so the same URL is safe to fetch, retain and display.
export function migrationLogUrl(value: unknown, targetApiUrl: string): string | null {
  if (typeof value !== "string" || !value) return null;
  const target = URL.parse(targetApiUrl);
  const log = URL.parse(value);
  if (target?.protocol !== "https:" || !log) return null;
  const host = target.hostname.replace(/^api\./, "");
  if (host !== "github.com" && !/^[a-z0-9-]+\.ghe\.com$/.test(host)) return null;
  // Check the literal authority too: URL parsing removes an explicit default port.
  if (!value.toLowerCase().startsWith(`https://${host}/`) || /[?#]/.test(value)) return null;
  return log.origin === `https://${host}` ? log.href : null;
}
