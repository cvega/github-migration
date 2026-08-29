export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface PollWithRetryOptions {
  poll: () => Promise<boolean>;
  wait: () => Promise<void>;
  shouldStop: () => boolean;
  maxConsecutiveErrors: number;
  onError: (error: unknown, consecutiveErrors: number) => void;
}

export async function pollWithRetry(options: PollWithRetryOptions): Promise<void> {
  let consecutiveErrors = 0;
  let firstPoll = true;
  while (!options.shouldStop()) {
    if (!firstPoll) await options.wait();
    firstPoll = false;
    if (options.shouldStop()) return;
    try {
      if (await options.poll()) return;
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      options.onError(error, consecutiveErrors);
      if (consecutiveErrors >= options.maxConsecutiveErrors) throw error;
    }
  }
}
