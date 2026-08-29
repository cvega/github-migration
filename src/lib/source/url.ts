export interface ParseSourceApiUrlOptions {
  label?: string;
  requireHttps?: boolean;
  insecureHttpMessage?: string;
}

export function parseSourceApiUrl(value: string, options: ParseSourceApiUrlOptions = {}): URL {
  const label = options.label ?? "Source API URL";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`${label} must use HTTP or HTTPS`);
  }
  if (options.requireHttps && url.protocol !== "https:") {
    throw new TypeError(options.insecureHttpMessage ?? `${label} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${label} must not include credentials, a query, or a fragment`);
  }
  return url;
}

export function assertPersistableSourceApiUrl(value: string): void {
  parseSourceApiUrl(value, { requireHttps: true });
}
