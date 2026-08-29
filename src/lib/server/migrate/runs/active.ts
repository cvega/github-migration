import type { CreateMigrationRequest } from "$lib/migrate/types";

export interface RunRegistration {
  signal: AbortSignal;
  token: symbol;
}

export class ActiveMigrationRuns {
  readonly #controllers = new Map<string, AbortController>();
  readonly #runTokens = new Map<string, symbol>();
  readonly #activePromises = new Map<string, Promise<void>>();
  readonly #queuedRequests = new Map<string, CreateMigrationRequest>();

  activeIds(): IterableIterator<string> {
    return this.#activePromises.keys();
  }

  isActive(id: string): boolean {
    return this.#activePromises.has(id);
  }

  claim(id: string, abortImmediately = false): RunRegistration | null {
    if (this.isActive(id)) return null;
    const controller = new AbortController();
    if (abortImmediately) controller.abort();
    const token = Symbol(id);
    this.#controllers.set(id, controller);
    this.#runTokens.set(id, token);
    return { signal: controller.signal, token };
  }

  attach(id: string, token: symbol, promise: Promise<void>): boolean {
    if (!this.owns(id, token)) return false;
    this.#activePromises.set(id, promise);
    return true;
  }

  owns(id: string, token: symbol): boolean {
    return this.#runTokens.get(id) === token;
  }

  finish(id: string, token: symbol): boolean {
    if (!this.owns(id, token)) return false;
    this.#controllers.delete(id);
    this.#runTokens.delete(id);
    this.#activePromises.delete(id);
    return true;
  }

  abort(id: string): boolean {
    const controller = this.#controllers.get(id);
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  enqueue(id: string, request: CreateMigrationRequest): void {
    this.#queuedRequests.set(id, request);
  }

  takeQueued(id: string): CreateMigrationRequest | undefined {
    const request = this.#queuedRequests.get(id);
    this.#queuedRequests.delete(id);
    return request;
  }

  dropQueued(id: string): boolean {
    return this.#queuedRequests.delete(id);
  }
}

export const activeMigrationRuns = new ActiveMigrationRuns();
