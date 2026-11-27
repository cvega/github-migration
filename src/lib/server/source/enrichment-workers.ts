// Both the project workers and any concurrent metrics within a project belong
// to the same run. Stop new requests on failure and join every started branch.
export function enrichmentWorkers(parent?: AbortSignal) {
  const failure = new AbortController();
  const signal = parent ? AbortSignal.any([parent, failure.signal]) : failure.signal;

  async function join<T extends unknown[]>(tasks: [...T]) {
    try {
      return await Promise.all(tasks);
    } catch (error) {
      failure.abort(error);
      await Promise.allSettled(tasks);
      throw failure.signal.reason;
    }
  }
  return { signal, join };
}
