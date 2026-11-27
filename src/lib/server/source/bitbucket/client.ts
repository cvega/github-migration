import { normalizeBitbucketServerApiUrl } from "$lib/server/core/source-url";

export { normalizeBitbucketServerApiUrl } from "$lib/server/core/source-url";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BitbucketServerClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  allowInsecureHttp?: boolean;
  fetch?: Fetcher;
  maxRetries?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  maxRetryDelayMs?: number;
  maxResponseBytes?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface BitbucketRequestOptions {
  distinguishMissingFile?: boolean;
  signal?: AbortSignal;
  maxItems?: number;
  maxItemsLabel?: string;
}

interface BitbucketPage<T> {
  values: T[];
  isLastPage: boolean;
  nextPageStart?: number;
  size?: number;
  limit?: number;
  start?: number;
}

export interface BitbucketExportStatus {
  id: string;
  state: string;
  message: string;
  percentage: number;
}

export class BitbucketServerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BitbucketServerApiError";
  }
}

export class BitbucketFileNotFoundError extends BitbucketServerApiError {}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function assertIntegerOption(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
}

function parseHeaderInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = parseHeaderInteger(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BitbucketServerApiError(
      response.status,
      `Bitbucket Server API response exceeds ${maxBytes} bytes`,
    );
  }
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BitbucketServerApiError(
        response.status,
        `Bitbucket Server API response exceeds ${maxBytes} bytes`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function retryAfterDelayMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function validatePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TypeError("Bitbucket Server API path must be absolute and same-origin");
  }
  for (const segment of path.split("/")) {
    let decoded = segment;
    for (let depth = 0; depth <= segment.length; depth += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw new TypeError("Bitbucket Server API path contains invalid encoding");
      }
      if (next === "." || next === "..") {
        throw new TypeError("Bitbucket Server API path must not contain dot segments");
      }
      if (next === decoded) break;
      if (depth === segment.length) {
        throw new TypeError("Bitbucket Server API path contains excessive encoding");
      }
      decoded = next;
    }
  }
}

export function encodeBitbucketSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized === "." || normalized === "..") {
    throw new TypeError(`${label} must be a non-empty path segment`);
  }
  return encodeURIComponent(normalized);
}

export class BitbucketServerClient {
  readonly apiUrl: string;
  readonly #authorization: string;
  readonly #fetch: Fetcher;
  readonly #maxRetries: number;
  readonly #maxPages: number;
  readonly #requestTimeoutMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #maxResponseBytes: number;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  #apiCalls = 0;

  constructor(options: BitbucketServerClientOptions) {
    if (!options.username.trim()) throw new TypeError("Bitbucket Server username is required");
    if (!options.password) throw new TypeError("Bitbucket Server password is required");
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    assertIntegerOption("maxRetries", maxRetries, 0);
    assertIntegerOption("maxPages", maxPages, 1);
    assertIntegerOption("requestTimeoutMs", requestTimeoutMs, 1);
    assertIntegerOption("maxRetryDelayMs", maxRetryDelayMs, 1);
    assertIntegerOption("maxResponseBytes", maxResponseBytes, 1);

    this.apiUrl = normalizeBitbucketServerApiUrl(options.baseUrl, {
      allowInsecureHttp: options.allowInsecureHttp,
    });
    this.#authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = maxRetries;
    this.#maxPages = maxPages;
    this.#requestTimeoutMs = requestTimeoutMs;
    // setTimeout runs immediately when its delay exceeds the signed 32-bit range.
    this.#maxRetryDelayMs = Math.min(maxRetryDelayMs, MAX_TIMER_DELAY_MS);
    this.#maxResponseBytes = maxResponseBytes;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  getApiCalls(): number {
    return this.#apiCalls;
  }

  async startRepositoryExport(
    projectKey: string,
    repositorySlug: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.post<{ id?: unknown }>(
      "/migration/exports",
      {
        repositoriesRequest: {
          includes: [
            {
              projectKey,
              slug: repositorySlug,
            },
          ],
        },
      },
      { signal },
    );
    const id = response.id;
    if (
      (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) &&
      (typeof id !== "string" || !/^[1-9]\d*$/.test(id))
    ) {
      throw new BitbucketServerApiError(200, "Bitbucket Server export ID was invalid");
    }
    return String(id);
  }

  async getRepositoryExport(
    exportId: string,
    signal?: AbortSignal,
  ): Promise<BitbucketExportStatus> {
    if (!/^[1-9]\d*$/.test(exportId)) {
      throw new TypeError("Bitbucket Server export ID must be a positive integer");
    }
    const response = await this.get<{
      id?: unknown;
      state?: unknown;
      progress?: { message?: unknown; percentage?: unknown };
    }>(`/migration/exports/${exportId}`, {}, { signal });
    if (typeof response.state !== "string" || !response.state) {
      throw new BitbucketServerApiError(200, "Bitbucket Server export state was invalid");
    }
    const message = response.progress?.message;
    const percentage = response.progress?.percentage;
    if (message !== undefined && message !== null && typeof message !== "string") {
      throw new BitbucketServerApiError(200, "Bitbucket Server export message was invalid");
    }
    if (
      percentage !== undefined &&
      percentage !== null &&
      (typeof percentage !== "number" ||
        !Number.isInteger(percentage) ||
        percentage < 0 ||
        percentage > 100)
    ) {
      throw new BitbucketServerApiError(200, "Bitbucket Server export percentage was invalid");
    }
    return {
      id: exportId,
      state: response.state,
      message: typeof message === "string" ? message : "",
      percentage: typeof percentage === "number" ? percentage : 0,
    };
  }

  async get<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    options: BitbucketRequestOptions = {},
  ): Promise<T> {
    return this.#request<T>("GET", path, query, undefined, options, true);
  }

  async post<T>(path: string, body: unknown, options: BitbucketRequestOptions = {}): Promise<T> {
    return this.#request<T>("POST", path, {}, body, options, false);
  }

  getRepositorySizes(project: string, slug: string, signal?: AbortSignal): Promise<unknown> {
    // Repository settings exposes sizes under the web context, not the REST API root.
    const path = `/projects/${encodeBitbucketSegment(project, "project key")}/repos/${encodeBitbucketSegment(slug, "repository slug")}/sizes`;
    return this.#request(
      "GET",
      path,
      {},
      undefined,
      { signal },
      false,
      this.apiUrl.replace(/\/rest\/api\/1\.0$/, ""),
    );
  }

  async *paginatePages<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    options: BitbucketRequestOptions = {},
  ): AsyncGenerator<T[]> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const initialStart = query.start ?? 0;
    if (typeof limit !== "number") throw new TypeError("limit must be a number");
    if (typeof initialStart !== "number") throw new TypeError("start must be a number");
    assertIntegerOption("limit", limit, 1);
    assertIntegerOption("start", initialStart, 0);
    if (limit > DEFAULT_PAGE_LIMIT) throw new TypeError("limit must not exceed 100");
    let start = initialStart;
    let itemsRead = 0;
    const cursors = new Set<number>();

    for (let pagesRead = 0; pagesRead < this.#maxPages; pagesRead += 1) {
      if (cursors.has(start)) {
        // Always follow the server cursor: repeated or non-forward positions
        // would loop or duplicate data because Bitbucket IDs are not contiguous.
        throw new BitbucketServerApiError(200, "Bitbucket Server pagination repeated a cursor");
      }
      cursors.add(start);
      const page = await this.get<BitbucketPage<T>>(path, { ...query, start, limit }, options);
      if (!page || typeof page !== "object" || !Array.isArray(page.values)) {
        throw new BitbucketServerApiError(200, "Bitbucket Server API page was invalid");
      }
      if (typeof page.isLastPage !== "boolean") {
        throw new BitbucketServerApiError(200, "Bitbucket Server API page omitted isLastPage");
      }
      if (page.values.length > limit) {
        throw new BitbucketServerApiError(200, "Bitbucket Server API page exceeded its limit");
      }
      if (options.maxItems !== undefined && itemsRead + page.values.length > options.maxItems) {
        throw new BitbucketServerApiError(
          200,
          `Bitbucket Server pagination exceeds the ${options.maxItems}-${options.maxItemsLabel ?? "item"} collection limit`,
        );
      }
      itemsRead += page.values.length;
      yield page.values;
      if (page.isLastPage) return;
      if (!Number.isSafeInteger(page.nextPageStart) || (page.nextPageStart ?? -1) <= start) {
        throw new BitbucketServerApiError(
          200,
          "Bitbucket Server API returned an invalid nextPageStart",
        );
      }
      start = page.nextPageStart as number;
    }
    throw new BitbucketServerApiError(
      0,
      `Bitbucket Server pagination exceeded ${this.#maxPages} pages`,
    );
  }

  async paginate<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    options: BitbucketRequestOptions = {},
  ): Promise<T[]> {
    const items: T[] = [];
    for await (const page of this.paginatePages<T>(path, query, options)) items.push(...page);
    return items;
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    body: unknown,
    options: BitbucketRequestOptions,
    retryable: boolean,
    baseUrl = this.apiUrl,
  ): Promise<T> {
    validatePath(path);
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        if (options.signal?.aborted) throw new BitbucketServerApiError(0, "aborted");
        const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
        this.#apiCalls += 1;
        response = await this.#fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: this.#authorization,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
          signal,
        });
      } catch (cause) {
        if (options.signal?.aborted) {
          throw new BitbucketServerApiError(0, "Bitbucket Server API request aborted", { cause });
        }
        if (retryable && attempt < this.#maxRetries) {
          await this.#waitBeforeRetry(this.#backoffDelayMs(attempt), options.signal);
          continue;
        }
        throw new BitbucketServerApiError(
          0,
          retryable
            ? "Bitbucket Server API request failed"
            : "Bitbucket Server API write outcome is unknown",
          { cause },
        );
      }

      if (retryable && isRetryableStatus(response.status) && attempt < this.#maxRetries) {
        await response.body?.cancel().catch(() => {});
        if (options.signal?.aborted) {
          throw new BitbucketServerApiError(0, "Bitbucket Server API request aborted");
        }
        const delayMs =
          retryAfterDelayMs(response.headers.get("retry-after"), this.#now()) ??
          this.#backoffDelayMs(attempt);
        if (delayMs > this.#maxRetryDelayMs) {
          throw new BitbucketServerApiError(
            response.status,
            `Bitbucket Server API returned HTTP ${response.status} with a cooldown beyond the retry delay budget`,
          );
        }
        await this.#waitBeforeRetry(delayMs, options.signal);
        continue;
      }
      if (!response.ok) {
        if (response.status === 404 && options.distinguishMissingFile) {
          const error = await readBoundedText(response, 16_384)
            .then((text) => JSON.parse(text) as { errors?: Array<{ exceptionName?: string }> })
            .catch(() => null);
          if (
            error?.errors?.[0]?.exceptionName ===
            "com.atlassian.bitbucket.content.NoSuchPathException"
          )
            throw new BitbucketFileNotFoundError(404, "File not found at revision");
        }
        await response.body?.cancel().catch(() => {});
        throw new BitbucketServerApiError(
          response.status,
          `Bitbucket Server API request failed with HTTP ${response.status}`,
        );
      }
      let responseText: string;
      try {
        responseText = await readBoundedText(response, this.#maxResponseBytes);
      } catch (cause) {
        if (cause instanceof BitbucketServerApiError) throw cause;
        if (options.signal?.aborted) {
          throw new BitbucketServerApiError(0, "Bitbucket Server API request aborted");
        }
        if (retryable && attempt < this.#maxRetries) {
          await this.#waitBeforeRetry(this.#backoffDelayMs(attempt), options.signal);
          continue;
        }
        throw new BitbucketServerApiError(
          0,
          "Bitbucket Server API response body could not be read",
        );
      }
      try {
        return JSON.parse(responseText) as T;
      } catch {
        throw new BitbucketServerApiError(
          response.status,
          "Bitbucket Server API returned invalid JSON",
        );
      }
    }
  }

  #backoffDelayMs(attempt: number): number {
    const jittered = 250 * 2 ** attempt * (0.8 + this.#random() * 0.4);
    return Math.min(Math.round(jittered), this.#maxRetryDelayMs);
  }

  async #waitBeforeRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.#sleep(milliseconds, signal);
    } catch {
      throw new BitbucketServerApiError(0, "Bitbucket Server API request aborted");
    }
  }
}
