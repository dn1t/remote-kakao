import type {
  AccountId,
  Capability,
  DeviceId,
  MessageId,
  MessageType,
  Platform,
  RoomId,
  RoomType,
  UserId,
} from "./protocol.ts";

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

/** User as plain data, which can be serialized as JSON. */
export interface UserData {
  id: UserId;
  name: string;
}

/** Account as plain data, which can be serialized as JSON. */
export interface AccountData {
  id: AccountId;
  me?: UserData;
}

/** Room as plain data, which can be serialized as JSON. */
export interface RoomData {
  /** Encoded string that identifies the room across restarts. */
  ref: string;
  id: RoomId;
  /** Id of the account the room belongs to. */
  account: AccountId;
  /** Id of the device the account is on. */
  device: DeviceId;
  name?: string;
  isGroup?: boolean;
  type: RoomType;
}

/** Message as plain data, which can be serialized as JSON. */
export interface MessageData {
  id: MessageId;
  room: RoomData;
  sender: UserData;
  type: MessageType;
  text: string;
  /** ISO 8601 timestamp. */
  time: string;
  hasMentions: boolean;
  mentions: UserData[];
  quoted?: { id: MessageId; text: string; sender?: UserData };
  replayed: boolean;
}

// TODO: `AuthOptions.verify` is not implemented yet
/** What a device presents when it connects. Passed to `AuthOptions.verify`. */
export interface DeviceHello {
  readonly device: { readonly id: DeviceId; readonly name: string; readonly platform: Platform };
  readonly client: { readonly name: string; readonly version: string };
  readonly protocolVersion: number;
  readonly capabilities: readonly Capability[];
  readonly accounts: readonly AccountData[];
  /** Ms the session can last. `undefined` for clients that stay connected. */
  readonly budget: number | undefined;
  /** Name of the transport the device connected through. */
  readonly transport: string;
  readonly remoteAddress: string;
}

/** Content to send to a room: text, or an image or a file given as a `Blob` or bytes. */
export type Sendable =
  | string
  | { readonly text: string }
  | { readonly image: Blob | Uint8Array; readonly caption?: string } // unverified
  | { readonly file: Blob | Uint8Array; readonly name: string }; // unverified

/** Result of sending a message. */
export interface SendResult {
  /** `undefined` when the client can't tell the id of the sent message. */
  readonly messageId: MessageId | undefined;
}

/**
 * Methods registered by client-side extensions, by name (`namespace:method`).
 * Add entries by augmenting this interface: `"namespace:method": { params: P; result: R }`.
 */
export interface ExtensionMethods {}

/** Names of the extension methods that have been typed. */
export type ExtensionMethodName = keyof ExtensionMethods & `${string}:${string}`;

/** Parameters of an extension method. */
export type ExtensionParams<M extends ExtensionMethodName> = ExtensionMethods[M] extends {
  params: infer P;
}
  ? P
  : never;

/** Result of an extension method. */
export type ExtensionResult<M extends ExtensionMethodName> = ExtensionMethods[M] extends {
  result: infer R;
}
  ? R
  : never;
