import { RKError } from "./errors.ts";
import type {
  EventName,
  EventPayload,
  IterateOptions,
  Listener,
  ListenerOptions,
  Unsubscribe,
  WaitOptions,
} from "./types.ts";

interface Entry {
  listener: (payload: unknown) => unknown;
  once: boolean;
  /** Removes the listener, and its abort listener on the signal. */
  off: () => void;
}

export interface EmitterHooks {
  /** A listener threw or rejected. */
  onListenerError(error: unknown, event: EventName): void;
  /** An iteration dropped its oldest payloads because it was not read fast enough. */
  onDrop(event: EventName, dropped: number): void;
}

/**
 * Calls the listeners of an event.
 * Unlike `EventEmitter`, a listener that throws or rejects never reaches the process,
 * never becomes an unhandled rejection and never stops the other listeners.
 * Its error goes to `onListenerError` instead.
 */
export class Emitter {
  readonly #hooks: EmitterHooks;
  readonly #listeners = new Map<EventName, Set<Entry>>();
  readonly #running = new Set<Promise<void>>();
  /** Ends every `wait` that is pending. */
  readonly #closers = new Set<() => void>();
  #closed = false;

  constructor(hooks: EmitterHooks) {
    this.#hooks = hooks;
  }

  /** Whether the event has a listener. */
  has(event: EventName): boolean {
    return this.#listeners.has(event);
  }

  /** Calls `listener` every time the event is emitted. */
  on<E extends EventName>(event: E, listener: Listener<E>, options?: ListenerOptions): Unsubscribe {
    return this.#add(event, listener as Entry["listener"], false, options?.signal);
  }

  /** Calls `listener` the next time the event is emitted, and then removes it. */
  once<E extends EventName>(
    event: E,
    listener: Listener<E>,
    options?: ListenerOptions,
  ): Unsubscribe {
    return this.#add(event, listener as Entry["listener"], true, options?.signal);
  }

  /**
   * Starts the listeners of the event, in the order they were added. The listeners that are
   * added or removed during the call take effect from the next call.
   * Resolves once the async listeners started by this call have settled.
   */
  emit<E extends EventName>(event: E, payload: EventPayload<E>): Promise<void> {
    const entries = this.#listeners.get(event);
    if (!entries) return Promise.resolve();

    const started: Promise<void>[] = [];
    for (const entry of Array.from(entries)) {
      if (!entries.has(entry)) continue; // removed by a listener that ran before it
      if (entry.once) entry.off();

      let result: unknown;
      try {
        result = entry.listener(payload);
      } catch (error) {
        this.#report(error, event);
        continue;
      }
      if (isThenable(result)) {
        const tracked = Promise.resolve(result).then(
          () => {},
          (error: unknown) => this.#report(error, event),
        );
        this.#running.add(tracked);
        void tracked.then(() => this.#running.delete(tracked));
        started.push(tracked);
      }
    }
    return Promise.all(started).then(() => {});
  }

  /**
   * Resolves with the next payload of the event that passes `filter`.
   * Rejects with `TIMEOUT` after `timeout` ms, with `ABORTED` when `signal` is aborted, and with
   * `CLOSED` if the emitter is closed, now or while waiting.
   * If `filter` throws, rejects with that error.
   */
  wait<E extends EventName>(
    event: E,
    options?: WaitOptions<EventPayload<E>>,
  ): Promise<EventPayload<E>> {
    if (this.#closed) return Promise.reject(closedError());
    const { filter, timeout, signal } = options ?? {};

    return new Promise<EventPayload<E>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;

      const finish = (settle: () => void) => {
        if (finished) return;
        finished = true;
        off();
        this.#closers.delete(onClose);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      const onClose = () => finish(() => reject(closedError()));
      const onAbort = () => {
        const error = new RKError("ABORTED", "wait aborted", { cause: signal?.reason });
        finish(() => reject(error));
      };

      const off = this.on(event, (payload) => {
        try {
          if (filter && !filter(payload)) return;
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        finish(() => resolve(payload));
      });
      this.#closers.add(onClose);

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeout !== undefined) {
        const error = new RKError("TIMEOUT", `no "${event}" within ${timeout}ms`);
        timer = setTimeout(() => finish(() => reject(error)), timeout);
      }
    });
  }

  /**
   * Iterates over the payloads of the event that pass `filter`, as they are emitted.
   * Payloads that come while the loop is busy are kept up to `buffer`, and the oldest are
   * dropped past that. The iteration ends when the loop stops, when `signal` is aborted, and when
   * the emitter is closed. If `filter` throws, the iteration throws that error after the payloads
   * that were kept.
   */
  iterate<E extends EventName>(
    event: E,
    options?: IterateOptions<EventPayload<E>>,
  ): AsyncIterableIterator<EventPayload<E>> {
    const { filter, signal, buffer = 1000 } = options ?? {};
    if (!Number.isInteger(buffer) || buffer < 1) {
      throw new RangeError("buffer must be a positive integer");
    }

    const kept: EventPayload<E>[] = [];
    let reader: Reader<IteratorResult<EventPayload<E>>> | undefined;
    let ended = false;
    let failure: { error: unknown } | undefined;

    const takeReader = () => {
      const current = reader;
      reader = undefined;
      return current;
    };
    const stop = () => {
      ended = true;
      off();
      this.#closers.delete(finish);
      signal?.removeEventListener("abort", finish);
    };
    const finish = () => {
      if (ended) return;
      stop();
      takeReader()?.resolve({ value: undefined, done: true });
    };
    const fail = (error: unknown) => {
      if (ended) return;
      stop();
      failure = { error };
      takeReader()?.reject(error);
    };

    const off = this.on(event, (payload) => {
      try {
        if (filter && !filter(payload)) return;
      } catch (error) {
        fail(error);
        return;
      }
      const waiting = takeReader();
      if (waiting) {
        waiting.resolve({ value: payload, done: false });
        return;
      }
      kept.push(payload);
      if (kept.length > buffer) {
        const dropped = kept.length - buffer;
        kept.splice(0, dropped);
        this.#hooks.onDrop(event, dropped);
      }
    });
    this.#closers.add(finish);

    if (this.#closed || signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });

    const iterator: AsyncIterableIterator<EventPayload<E>> = {
      next: () => {
        if (kept.length > 0) return Promise.resolve({ value: kept.shift()!, done: false });
        if (failure) {
          const { error } = failure;
          failure = undefined;
          return Promise.reject(error);
        }
        if (ended) return Promise.resolve({ value: undefined, done: true });
        if (reader) return Promise.reject(new Error("an event is already being read"));
        return new Promise((resolve, reject) => {
          reader = { resolve, reject };
        });
      },
      // Called when the loop stops early, e.g. with `break`.
      return: () => {
        finish();
        kept.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  /** Waits until every async listener started so far has settled. */
  async settle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running);
  }

  /**
   * Rejects the waits that are pending with `CLOSED`, and so will every wait from now on.
   * Removes all listeners.
   */
  close(): void {
    this.#closed = true;
    for (const close of Array.from(this.#closers)) close();
    this.#closers.clear();
    // Through `off`, so that an emit in progress skips them and no signal keeps them.
    for (const entries of Array.from(this.#listeners.values())) {
      for (const entry of Array.from(entries)) entry.off();
    }
  }

  #add(
    event: EventName,
    listener: Entry["listener"],
    once: boolean,
    signal: AbortSignal | undefined,
  ): Unsubscribe {
    const entry: Entry = { listener, once, off: () => {} };
    const entries = this.#listeners.get(event) ?? new Set<Entry>();
    entries.add(entry);
    this.#listeners.set(event, entries);

    const off = unsubscribe(() => {
      this.#remove(event, entry);
      signal?.removeEventListener("abort", off);
    });
    entry.off = off;
    if (signal?.aborted) off();
    else signal?.addEventListener("abort", off, { once: true });
    return off;
  }

  #remove(event: EventName, entry: Entry): void {
    const entries = this.#listeners.get(event);
    entries?.delete(entry);
    if (entries?.size === 0) this.#listeners.delete(event);
  }

  #report(error: unknown, event: EventName): void {
    try {
      this.#hooks.onListenerError(error, event);
    } catch {
      // A failing hook has nobody left to tell, and must not reach the process.
    }
  }
}

interface Reader<T> {
  resolve(result: T): void;
  reject(error: unknown): void;
}

function closedError(): RKError {
  return new RKError("CLOSED", "RemoteKakao is closed");
}

/** Makes the function that `on` returns: it does its work once, and can be used with `using`. */
function unsubscribe(off: () => void): Unsubscribe {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    off();
  };
  return Object.assign(run, { [Symbol.dispose]: run });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
