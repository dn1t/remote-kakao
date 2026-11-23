interface Reader {
  resolve(result: IteratorResult<Uint8Array>): void;
  reject(error: unknown): void;
}

/**
 * Frames that arrive on a link, read with `for await`.
 * A transport `push`es each frame, then calls `end` when the link closes or `fail` when it breaks.
 * Frames pushed before they are read are kept in order, and are read before the end or the failure.
 * Only one read can wait at a time.
 */
export class FrameQueue implements AsyncIterable<Uint8Array> {
  readonly #frames: Uint8Array[] = [];
  #reader: Reader | undefined;
  #closed = false;
  #failure: { error: unknown } | undefined;

  /** Adds a frame. Ignored once the queue has ended or failed. */
  push(frame: Uint8Array): void {
    if (this.#closed) return;
    const reader = this.#takeReader();
    if (reader) reader.resolve({ value: frame, done: false });
    else this.#frames.push(frame);
  }

  /** Ends the iteration after the frames that are already queued. */
  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#takeReader()?.resolve({ value: undefined, done: true });
  }

  /** Makes the iteration throw `error` after the frames that are already queued. */
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = { error };
    this.#takeReader()?.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        const frame = this.#frames.shift();
        if (frame) return Promise.resolve({ value: frame, done: false });
        if (this.#failure) return Promise.reject(this.#failure.error);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        if (this.#reader) return Promise.reject(new Error("a frame is already being read"));
        return new Promise((resolve, reject) => {
          this.#reader = { resolve, reject };
        });
      },
      // Called when the loop stops early, e.g. with `break`.
      return: (): Promise<IteratorResult<Uint8Array>> => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  #takeReader(): Reader | undefined {
    const reader = this.#reader;
    this.#reader = undefined;
    return reader;
  }
}
