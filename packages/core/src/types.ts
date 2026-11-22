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

/**
 * Moves sealed frames between the core and devices over a network protocol.
 * It only carries bytes: handshake, encryption, retries and de-duplication are done by the core.
 */
export interface Transport {
  /** Short name for logs and session info, e.g. "udp". */
  readonly name: string;
  /** Starts the transport. Each device connection is passed to `accept` as a `Link`. Resolves once ready. */
  listen(accept: (link: Link) => void): Promise<TransportHandle>;
}

/** A running transport, returned by `Transport.listen`. */
export interface TransportHandle {
  /** For logs, e.g. "udp://0.0.0.0:3000". */
  readonly address: string;
  /** Stops accepting new links. The core closes the existing links before calling. */
  close(): Promise<void>;
}

/** Connection to one device. Carries whole sealed frames in both directions. */
export interface Link {
  /** Address of the device, for logs and session info. */
  readonly remoteAddress: string;
  /** `false` for links like UDP, where frames may be lost or duplicated: the core retransmits frames that go unanswered. */
  readonly reliable: boolean;
  /** Frames received from the device. The iteration ends when the link closes normally, and throws if it breaks. */
  readonly frames: AsyncIterable<Uint8Array>;
  /** Resolves once the frame is written. Waits while the buffer is full, and rejects if the link is closed. */
  send(frame: Uint8Array): Promise<void>;
  /** Closes the link. `reason` is only informational, e.g. for logs. */
  close(reason?: string): void;
}
