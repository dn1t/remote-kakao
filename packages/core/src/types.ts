/** Where remote-kakao writes its logs. `console` satisfies. */
export interface Logger {
  debug(message: string, context?: object): void;
  info(message: string, context?: object): void;
  warn(message: string, context?: object): void;
  error(message: string, context?: object): void;
}

/** Options shared by every call that waits for a device to answer. */
export interface RequestOptions {
  // TODO: the `requestTimeout` option of `RemoteKakao` is not implemented yet
  /** Deadline in ms. Defaults to the `requestTimeout` option of `RemoteKakao`. */
  timeout?: number;
  /** Aborts the call, which then rejects with `ABORTED`. */
  signal?: AbortSignal;
}

/** Call to remove the listener, or declare with `using` to remove it at the end of the scope. */
export type Unsubscribe = (() => void) & Disposable;

/** Options for `on` and `once`. */
export interface ListenerOptions {
  /** Removes the listener when aborted. */
  signal?: AbortSignal;
}

// TODO: `wait` and `nextMessage` are not implemented yet
/** Options for waiting until an event happens once, e.g. `wait` and `nextMessage`. */
export interface WaitOptions<T> {
  /** The wait resolves with the first payload for which this returns `true`. Other payloads are skipped. */
  filter?: (payload: T) => boolean;
  /** Deadline in ms. Rejects with `TIMEOUT`. Waits indefinitely by default. */
  timeout?: number;
  /** Aborts the wait, which then rejects with `ABORTED`. */
  signal?: AbortSignal;
}

// TODO: `iterate` and `messages` are not implemented yet
/** Options for looping over every payload of an event with `for await`, e.g. `iterate` and `messages`. */
export interface IterateOptions<T> {
  /** Payloads for which this returns `false` are skipped. */
  filter?: (payload: T) => boolean;
  /** Ends the iteration when aborted. */
  signal?: AbortSignal;
  /** Payloads buffered while the loop is busy. Oldest are dropped past this (reported via `error`). Default `1000`. */
  buffer?: number;
}
