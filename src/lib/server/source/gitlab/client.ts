import { normalizeGitLabApiUrl } from "$lib/server/core/source-url";

export { normalizeGitLabApiUrl } from "$lib/server/core/source-url";

export interface GitLabRateLimit {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
  retryAfterSeconds: number | null;
}

export type GitLabCountObservation =
  | { kind: "exact"; value: number; basis: "reported" | "enumerated" }
  | { kind: "at-least"; value: number }
  | { kind: "unavailable"; reason: "forbidden" | "not-found-or-hidden" | "malformed" };

interface GitLabResponse<T> {
  data: T;
  headers: Headers;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitLabClientOptions {
  baseUrl: string;
  token: string;
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

export interface GitLabRequestOptions {
  signal?: AbortSignal;
  maxItems?: number;
  maxItemsLabel?: string;
  onPaginationComplete?: (total: number | null, itemsRead: number) => void;
}

type GitLabExportState =
  | "none"
  | "queued"
  | "started"
  | "finished"
  | "regeneration_in_progress"
  | "failed";

export interface GitLabExportStatus {
  state: GitLabExportState;
}

export interface GitLabArchiveDownloadOptions {
  signal?: AbortSignal;
  maxBytes: number;
  timeoutMs: number;
}

export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitLabApiError";
  }
}

export class GitLabPaginationError extends GitLabApiError {
  constructor(message: string) {
    super(200, message);
    this.name = "GitLabPaginationError";
  }
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readBoundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  const declaredLength = parseHeaderInteger(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new GitLabApiError(response.status, `GitLab API response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return JSON.parse(await response.text()) as T;

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
      throw new GitLabApiError(response.status, `GitLab API response exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as T;
}

function parseHeaderInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readPaginationLinks(
  value: string,
  currentPage: number,
): { hasNext: boolean; lastPage: number | null } | null {
  let hasNext = false;
  let lastPage: number | null = null;
  // Consume complete link values so quoted parameters and targets can contain commas.
  const link =
    /\s*<([^<>]+)>((?:\s*;\s*[\w-]+(?:\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^\s;,"]+))?)*)\s*(,|$)/gy;
  let offset = 0;
  while (offset < value.length) {
    const entry = link.exec(value);
    if (!entry) return null;
    offset = link.lastIndex;
    const [, target, parameters] = entry;
    if (target === undefined || parameters === undefined) return null;
    for (const parameter of parameters.matchAll(
      /;\s*([\w-]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;,"]+)))?/g,
    )) {
      if (parameter[1]?.toLowerCase() !== "rel") continue;
      const relations = (parameter[2] ?? parameter[3] ?? "").toLowerCase().trim().split(/\s+/);
      const previous = relations.includes("prev") || relations.includes("previous");
      const next = relations.includes("next");
      const last = relations.includes("last");
      if (!previous && !next && !last) continue;
      const url = URL.parse(target, "https://gitlab.invalid");
      const pages = url?.searchParams.getAll("page");
      const page = pages?.length === 1 ? parseHeaderInteger(pages[0] ?? null) : null;
      if (
        page === null ||
        page === 0 ||
        (next && page !== currentPage + 1) ||
        (previous && page !== currentPage - 1)
      ) {
        return null;
      }
      if (last) {
        if (lastPage !== null && lastPage !== page) return null;
        lastPage = page;
      }
      hasNext ||= next;
    }
    if (entry[3] === "," && offset === value.length) return null;
  }
  return { hasNext, lastPage };
}

function observeFirstPageCount(itemsRead: number, headers: Headers): GitLabCountObservation {
  const malformed = { kind: "unavailable", reason: "malformed" } as const;
  const page = headers.get("x-page");
  const perPage = headers.get("x-per-page");
  if (
    (page !== null && parseHeaderInteger(page) !== 1) ||
    (perPage !== null && parseHeaderInteger(perPage) !== 1) ||
    headers.get("x-prev-page")
  ) {
    return malformed;
  }

  const totalHeader = headers.get("x-total");
  const total = parseHeaderInteger(totalHeader);
  if (totalHeader !== null && total === null) return malformed;
  // With per_page=1, the reported item count and page count must agree.
  const totalPagesHeader = headers.get("x-total-pages");
  const totalPages = parseHeaderInteger(totalPagesHeader);
  if (totalPagesHeader !== null && totalPages === null) return malformed;
  const links = readPaginationLinks(headers.get("Link") ?? "", 1);
  if (!links) return malformed;
  const reportedSize = total ?? totalPages ?? links.lastPage;
  if (
    [total, totalPages, links.lastPage].some(
      (size) => size !== null && (size !== reportedSize || Math.min(size, 1) !== itemsRead),
    )
  ) {
    return malformed;
  }

  const nextPage = headers.get("x-next-page");
  if (nextPage && parseHeaderInteger(nextPage) !== 2) return malformed;
  const hasNextPage = Boolean(nextPage) || links.hasNext || (reportedSize ?? 0) > 1;
  if (hasNextPage && (nextPage === "" || (reportedSize !== null && reportedSize <= 1))) {
    return malformed;
  }
  if (itemsRead > 1 || (itemsRead === 0 && hasNextPage)) return malformed;

  if (total !== null) {
    return { kind: "exact", value: total, basis: "reported" };
  }
  if (itemsRead === 0 || nextPage === "") {
    return { kind: "exact", value: itemsRead, basis: "enumerated" };
  }
  return { kind: "at-least", value: itemsRead };
}

function readTraversalPage(
  headers: Headers,
  page: number,
  perPage: number,
  itemsOnPage: number,
  knownLastPage: number | null,
): { lastPage: number | null; continues: boolean | null } {
  const reportedPage = headers.get("x-page");
  const reportedPerPage = headers.get("x-per-page");
  const previous = headers.get("x-prev-page");
  const next = headers.get("x-next-page");
  if (next && parseHeaderInteger(next) !== page + 1) {
    throw new GitLabPaginationError("GitLab API returned an invalid X-Next-Page header");
  }
  const pagesHeader = headers.get("x-total-pages");
  const totalPages = parseHeaderInteger(pagesHeader);
  const links = readPaginationLinks(headers.get("Link") ?? "", page);
  if (
    (reportedPage !== null && parseHeaderInteger(reportedPage) !== page) ||
    (reportedPerPage !== null && parseHeaderInteger(reportedPerPage) !== perPage) ||
    (previous !== null &&
      (page === 1 ? previous !== "" : parseHeaderInteger(previous) !== page - 1)) ||
    (pagesHeader !== null && totalPages === null) ||
    !links ||
    itemsOnPage > perPage
  ) {
    throw new GitLabPaginationError("GitLab API returned malformed pagination evidence");
  }

  const lastPage = knownLastPage ?? totalPages ?? links.lastPage;
  const explicitContinuation = Boolean(next) || links.hasNext;
  const pagesRemain = lastPage !== null && lastPage > page;
  if (
    (totalPages !== null && totalPages !== lastPage) ||
    (links.lastPage !== null && links.lastPage !== lastPage) ||
    (lastPage === 0 ? page !== 1 || itemsOnPage !== 0 : lastPage !== null && lastPage < page) ||
    (next === "" && (explicitContinuation || pagesRemain)) ||
    (explicitContinuation && lastPage !== null && !pagesRemain) ||
    (itemsOnPage === 0 && (explicitContinuation || (lastPage ?? 0) >= page))
  ) {
    throw new GitLabPaginationError("GitLab API returned contradictory pagination evidence");
  }

  if (explicitContinuation || pagesRemain) return { lastPage, continues: true };
  if (next === "" || lastPage !== null) return { lastPage, continues: false };
  return { lastPage, continues: null };
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

function validatePath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TypeError("GitLab API path must be absolute and same-origin");
  }
  for (const segment of path.split("/")) {
    let decoded = segment;
    for (let depth = 0; depth <= segment.length; depth += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === "." || next === "..") {
          throw new TypeError("GitLab API path must not contain dot segments");
        }
        if (next === decoded) break;
        if (depth === segment.length) {
          throw new TypeError("GitLab API path contains excessive encoding");
        }
        decoded = next;
      } catch (error) {
        if (error instanceof TypeError && error.message.includes("dot segments")) throw error;
        throw new TypeError("GitLab API path contains invalid encoding");
      }
    }
  }
}

function assertIntegerOption(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
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

export function encodeGitLabPath(path: string): string {
  const normalized = path.trim();
  if (
    !normalized ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === ".." || /\s/.test(segment))
  ) {
    throw new TypeError("GitLab path must contain non-empty namespace segments");
  }
  return encodeURIComponent(normalized);
}

export class GitLabClient {
  readonly apiUrl: string;
  readonly #token: string;
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
  #rateLimit: GitLabRateLimit = {
    limit: null,
    remaining: null,
    reset: null,
    retryAfterSeconds: null,
  };

  constructor(options: GitLabClientOptions) {
    if (!options.token.trim()) throw new TypeError("GitLab token is required");
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

    this.apiUrl = normalizeGitLabApiUrl(options.baseUrl, {
      allowInsecureHttp: options.allowInsecureHttp,
    });
    this.#token = options.token;
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

  getRateLimit(): GitLabRateLimit {
    return { ...this.#rateLimit };
  }

  async startProjectExport(projectPath: string, signal?: AbortSignal): Promise<void> {
    const path = `/projects/${encodeGitLabPath(projectPath)}/export`;
    validatePath(path);
    const url = new URL(`${this.apiUrl}${path}`);
    let response: Response;
    try {
      if (signal?.aborted) throw new GitLabApiError(0, "GitLab API request aborted");
      const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
      this.#apiCalls += 1;
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": this.#token,
        },
        body: "{}",
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (cause) {
      if (cause instanceof GitLabApiError || signal?.aborted) {
        throw new GitLabApiError(0, "GitLab API request aborted", { cause });
      }
      throw new GitLabApiError(0, "GitLab export creation outcome is unknown", { cause });
    }

    this.#captureRateLimit(response.headers);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitLabApiError(
        response.status,
        `GitLab API request failed with HTTP ${response.status}`,
      );
    }
    await response.body?.cancel().catch(() => {});
  }

  async unarchiveProject(projectPath: string, signal?: AbortSignal): Promise<void> {
    const path = `/projects/${encodeGitLabPath(projectPath)}/unarchive`;
    validatePath(path);
    const url = new URL(`${this.apiUrl}${path}`);
    let response: Response;
    try {
      if (signal?.aborted) throw new GitLabApiError(0, "GitLab API request aborted");
      const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
      this.#apiCalls += 1;
      response = await this.#fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "PRIVATE-TOKEN": this.#token },
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (cause) {
      throw new GitLabApiError(0, "GitLab project unlock outcome is unknown", { cause });
    }
    this.#captureRateLimit(response.headers);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitLabApiError(
        response.status,
        `GitLab project unlock failed with HTTP ${response.status}`,
      );
    }
    await response.body?.cancel().catch(() => {});
  }

  async isProjectArchived(projectPath: string, signal?: AbortSignal): Promise<boolean> {
    const { data } = await this.get<{ archived?: unknown }>(
      `/projects/${encodeGitLabPath(projectPath)}`,
      {},
      { signal },
    );
    if (typeof data.archived !== "boolean") {
      throw new GitLabApiError(200, "GitLab project archive state was invalid");
    }
    return data.archived;
  }

  async getProjectExport(projectPath: string, signal?: AbortSignal): Promise<GitLabExportStatus> {
    const { data } = await this.get<{ export_status?: unknown }>(
      `/projects/${encodeGitLabPath(projectPath)}/export`,
      {},
      { signal },
    );
    const state = data.export_status;
    if (
      state !== "none" &&
      state !== "queued" &&
      state !== "started" &&
      state !== "finished" &&
      state !== "regeneration_in_progress" &&
      state !== "failed"
    ) {
      throw new GitLabApiError(200, "GitLab export status was invalid");
    }
    return { state };
  }

  async downloadProjectExport(
    projectPath: string,
    destinationPath: string,
    options: GitLabArchiveDownloadOptions,
  ): Promise<void> {
    assertIntegerOption("maxBytes", options.maxBytes, 1);
    assertIntegerOption("timeoutMs", options.timeoutMs, 1);
    const path = `/projects/${encodeGitLabPath(projectPath)}/export/download`;
    validatePath(path);
    const url = new URL(`${this.apiUrl}${path}`);
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      signal.throwIfAborted();
      this.#apiCalls += 1;
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/gzip, application/octet-stream",
          "PRIVATE-TOKEN": this.#token,
        },
        redirect: "manual",
        signal,
      });
    } catch (cause) {
      throw new GitLabApiError(0, "GitLab export download failed", { cause });
    }

    this.#captureRateLimit(response.headers);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitLabApiError(
        response.status,
        `GitLab export download failed with HTTP ${response.status}`,
      );
    }
    const declaredLength = parseHeaderInteger(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > options.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new GitLabApiError(
        response.status,
        `GitLab export archive exceeds ${options.maxBytes} bytes`,
      );
    }
    if (!response.body) throw new GitLabApiError(response.status, "GitLab export was empty");

    const writer = Bun.file(destinationPath).writer();
    let bytesWritten = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytesWritten += value.byteLength;
        if (bytesWritten > options.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new GitLabApiError(
            response.status,
            `GitLab export archive exceeds ${options.maxBytes} bytes`,
          );
        }
        writer.write(value);
      }
      await writer.flush();
    } catch (cause) {
      if (cause instanceof GitLabApiError) throw cause;
      throw new GitLabApiError(0, "GitLab export download failed", { cause });
    } finally {
      writer.end();
    }
  }

  async get<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    options: GitLabRequestOptions = {},
  ): Promise<GitLabResponse<T>> {
    validatePath(path);
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        if (options.signal?.aborted) {
          throw new GitLabApiError(0, "GitLab API request aborted");
        }
        const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
        this.#apiCalls += 1;
        response = await this.#fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", "PRIVATE-TOKEN": this.#token },
          redirect: "manual",
          signal,
        });
      } catch (cause) {
        if (cause instanceof GitLabApiError || options.signal?.aborted) {
          throw new GitLabApiError(0, "GitLab API request aborted", { cause });
        }
        if (attempt < this.#maxRetries) {
          await this.#waitBeforeRetry(this.#backoffDelayMs(attempt), options.signal);
          continue;
        }
        throw new GitLabApiError(0, "GitLab API request failed", { cause });
      }

      this.#captureRateLimit(response.headers);
      if (isRetryableStatus(response.status) && attempt < this.#maxRetries) {
        await response.body?.cancel().catch(() => {});
        if (options.signal?.aborted) {
          throw new GitLabApiError(0, "GitLab API request aborted");
        }
        const nowMs = this.#now();
        const retryAfter = retryAfterDelayMs(response.headers.get("retry-after"), nowMs);
        const throttled =
          response.status === 429 ||
          parseHeaderInteger(response.headers.get("ratelimit-remaining")) === 0;
        const reset = throttled ? response.headers.get("ratelimit-reset") : null;
        const delayMs =
          retryAfter ??
          (reset && /^\d+$/.test(reset)
            ? Math.max(0, Number(reset) * 1_000 - nowMs)
            : this.#backoffDelayMs(attempt));
        if (delayMs > this.#maxRetryDelayMs) {
          throw new GitLabApiError(
            response.status,
            `GitLab API returned HTTP ${response.status} with a cooldown beyond the retry delay budget`,
          );
        }
        await this.#waitBeforeRetry(delayMs, options.signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new GitLabApiError(
          response.status,
          `GitLab API request failed with HTTP ${response.status}`,
        );
      }

      try {
        return {
          data: await readBoundedJson<T>(response, this.#maxResponseBytes),
          headers: response.headers,
        };
      } catch (cause) {
        if (cause instanceof GitLabApiError) throw cause;
        if (options.signal?.aborted) {
          throw new GitLabApiError(0, "GitLab API request aborted");
        }
        if (!(cause instanceof SyntaxError) && attempt < this.#maxRetries) {
          await this.#waitBeforeRetry(this.#backoffDelayMs(attempt), options.signal);
          continue;
        }
        if (cause instanceof SyntaxError) {
          throw new GitLabApiError(response.status, "GitLab API returned invalid JSON");
        }
        throw new GitLabApiError(0, "GitLab API response body could not be read");
      }
    }
  }

  async *paginatePages<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    options: GitLabRequestOptions = {},
  ): AsyncGenerator<T[]> {
    const perPage = query.per_page ?? DEFAULT_PER_PAGE;
    const initialPage = query.page ?? 1;
    if (typeof perPage !== "number") throw new TypeError("per_page must be a number");
    if (typeof initialPage !== "number") throw new TypeError("page must be a number");
    assertIntegerOption("per_page", perPage, 1);
    assertIntegerOption("page", initialPage, 1);
    if (perPage > DEFAULT_PER_PAGE) throw new TypeError("per_page must not exceed 100");
    let page = initialPage;
    let itemsRead = 0;
    let total: number | null = null;
    let lastPage: number | null = null;
    let continuationExpected = false;

    for (let pagesRead = 0; pagesRead < this.#maxPages; pagesRead += 1) {
      const response: GitLabResponse<T[]> = await this.get<T[]>(
        path,
        { ...query, page, per_page: perPage },
        options,
      );
      if (!Array.isArray(response.data)) {
        throw new GitLabPaginationError("GitLab API page was not an array");
      }
      if (continuationExpected && response.data.length === 0) {
        throw new GitLabPaginationError("GitLab API returned contradictory pagination evidence");
      }
      const pageTotalHeader = response.headers.get("x-total");
      if (pageTotalHeader !== null) {
        const pageTotal = parseHeaderInteger(pageTotalHeader);
        if (pageTotal === null) {
          throw new GitLabPaginationError("GitLab API returned an invalid X-Total header");
        }
        if (total !== null && pageTotal !== total) {
          // A changing total proves the offset traversal observed different
          // collection versions, so returning a reconciled inventory is unsafe.
          throw new GitLabPaginationError("GitLab inventory changed during pagination");
        }
        total = pageTotal;
      }
      if (
        options.maxItems !== undefined &&
        ((total !== null && total > options.maxItems) ||
          itemsRead + response.data.length > options.maxItems)
      ) {
        throw new GitLabApiError(
          200,
          `GitLab pagination exceeds the ${options.maxItems}-${options.maxItemsLabel ?? "item"} collection limit`,
        );
      }
      itemsRead += response.data.length;
      const traversal = readTraversalPage(
        response.headers,
        page,
        perPage,
        response.data.length,
        lastPage,
      );
      lastPage = traversal.lastPage;
      if (total !== null && lastPage !== null && Math.ceil(total / perPage) !== lastPage) {
        throw new GitLabPaginationError("GitLab API returned contradictory pagination totals");
      }
      const continues = traversal.continues ?? response.data.length === perPage;
      if (
        total !== null &&
        (itemsRead > total ||
          (traversal.continues === true && itemsRead === total) ||
          (!continues && itemsRead !== total))
      ) {
        throw new GitLabPaginationError("GitLab pagination did not match X-Total");
      }
      yield response.data;

      if (!continues) {
        options.onPaginationComplete?.(total, itemsRead);
        return;
      }
      continuationExpected = traversal.continues === true;
      page += 1;
    }

    throw new GitLabApiError(0, `GitLab pagination exceeded ${this.#maxPages} pages`);
  }

  async paginate<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    options: GitLabRequestOptions = {},
  ): Promise<T[]> {
    const items: T[] = [];
    for await (const page of this.paginatePages<T>(path, query, options)) items.push(...page);
    return items;
  }

  async count(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    options: GitLabRequestOptions = {},
  ): Promise<GitLabCountObservation> {
    try {
      const response = await this.get<unknown[]>(path, { ...query, page: 1, per_page: 1 }, options);
      if (!Array.isArray(response.data)) {
        throw new GitLabApiError(200, "GitLab count response was not an array");
      }
      return observeFirstPageCount(response.data.length, response.headers);
    } catch (error) {
      if (!(error instanceof GitLabApiError)) throw error;
      if (error.status === 403) return { kind: "unavailable", reason: "forbidden" };
      if (error.status === 404) {
        return { kind: "unavailable", reason: "not-found-or-hidden" };
      }
      throw error;
    }
  }

  #captureRateLimit(headers: Headers): void {
    const delayMs = retryAfterDelayMs(headers.get("retry-after"), this.#now());
    const retryAfterSeconds = delayMs === null ? null : Math.ceil(delayMs / 1_000);
    this.#rateLimit = {
      limit: parseHeaderInteger(headers.get("ratelimit-limit")) ?? this.#rateLimit.limit,
      remaining:
        parseHeaderInteger(headers.get("ratelimit-remaining")) ?? this.#rateLimit.remaining,
      reset: headers.get("ratelimit-reset") ?? this.#rateLimit.reset,
      retryAfterSeconds: Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : null,
    };
  }

  #backoffDelayMs(attempt: number): number {
    const jittered = 250 * 2 ** attempt * (0.8 + this.#random() * 0.4);
    return Math.min(Math.round(jittered), this.#maxRetryDelayMs);
  }

  async #waitBeforeRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.#sleep(milliseconds, signal);
    } catch {
      throw new GitLabApiError(0, "GitLab API request aborted");
    }
  }
}
