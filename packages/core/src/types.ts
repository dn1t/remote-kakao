import type { RKError } from "./errors.ts";
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

/** Device that runs a client. The same object is kept across sessions; `status` follows them. */
export interface Device {
  readonly id: DeviceId;
  /** Human-readable label, e.g. "Galaxy S24". */
  readonly name: string;
  readonly platform: Platform;
  readonly client: { readonly name: string; readonly version: string };
  /** `online` while a session is open. */
  readonly status: "online" | "offline";
  /** Protocol version from the latest handshake. */
  readonly protocolVersion: number;
  readonly capabilities: ReadonlySet<Capability>;
  readonly accounts: readonly Account[];
  readonly session: DeviceSession | undefined;
  /** When a session with the device last started or ended. `undefined` if it never connected. */
  readonly lastSeenAt: Date | undefined;

  /** Whether the device supports the capability. */
  supports(capability: Capability): boolean;
  account(id: AccountId): Account | undefined;
  /** Round-trip time in ms. */
  ping(options?: RequestOptions): Promise<number>;
  /** Calls a method registered by a client-side extension. */
  call<M extends ExtensionMethodName>(
    method: M,
    params: ExtensionParams<M>,
    options?: RequestOptions,
  ): Promise<ExtensionResult<M>>;
  /** Ends the current session. Does nothing if there is none. */
  disconnect(reason?: string): void;
}

/** Open session of a device. */
export interface DeviceSession {
  /** Name of the transport the device is connected through. */
  readonly transport: string;
  readonly remoteAddress: string;
  readonly startedAt: Date;
  /** When the budget declared by the client runs out. `undefined` for clients that stay connected. */
  readonly expiresAt: Date | undefined;
}

/** KakaoTalk account signed in on a device. */
export interface Account {
  /** Unique within its device. The format depends on the client, e.g. `<package>/<android user>` on Android, the bundle id on iOS. */
  readonly id: AccountId;
  readonly device: Device;
  /** The user this account is signed in as, if the client can tell. */
  readonly me: User | undefined;

  /** Room of this account with the given id. Does not ask the device. */
  room(id: RoomId): Room;
  /** Requires `room.list`. */
  rooms(options?: RequestOptions): Promise<Room[]>; // unverified
}

/** Chat room of an account. */
export interface Room {
  /** Encoded string that identifies the room across restarts. Keep it to get the same room again later. */
  readonly ref: string;
  readonly id: RoomId;
  readonly account: Account;
  readonly device: Device;
  /** Last known name. `undefined` until the device has described the room. */
  readonly name: string | undefined;
  /** Last known value. `undefined` until the device has described the room. */
  readonly isGroup: boolean | undefined;
  /** Last known type. `"unknown"` until the device has described the room. */
  readonly type: RoomType;

  /** Whether the device supports the capability. */
  supports(capability: Capability): boolean;
  /**
   * Requires `room.send`, plus `send.image` or `send.file` for those payloads.
   * Resolves once the message is handed to KakaoTalk, not once it is delivered.
   */
  send(content: Sendable, options?: SendOptions): Promise<SendResult>;
  /** Requires `room.markRead`. */
  markRead(options?: RequestOptions): Promise<void>;
  /** Requires `room.icon`. */
  icon(options?: RequestOptions): Promise<Blob | undefined>;
  /** Requires `room.members`. */
  members(options?: RequestOptions): Promise<User[]>; // unverified
  /** Requires `room.history`. Newest first. */
  history(options?: HistoryOptions): Promise<Message[]>; // unverified
  /** Resolves with the next message in this room. */
  nextMessage(options?: NextMessageOptions): Promise<Message>;
  /** Iterates over the messages in this room as they arrive. */
  messages(options?: IterateOptions<Message>): AsyncIterableIterator<Message>;
  toJSON(): RoomData;
}

/** KakaoTalk user. */
export interface User {
  readonly id: UserId;
  readonly name: string;
  readonly account: Account;
  /** `true` if this is the user the account is signed in as. */
  readonly isMe: boolean;

  /** Requires `user.avatar`. */
  avatar(options?: RequestOptions): Promise<Blob | undefined>;
  toJSON(): UserData;
}

/** Immutable snapshot of a message. */
export interface Message {
  readonly id: MessageId;
  readonly room: Room;
  readonly sender: User;
  readonly type: MessageType;
  /** For types other than "text", contains KakaoTalk's preview text (e.g. "사진"). */
  readonly text: string;
  readonly time: Date;
  readonly hasMentions: boolean;
  /** Mentioned users. Empty without `message.mentions`. */
  readonly mentions: readonly User[]; // unverified
  /** Files attached to the message. Empty without `message.attachments`. */
  readonly attachments: readonly Attachment[]; // unverified
  /** The message this one quotes. `undefined` without `message.quotes`. */
  readonly quoted: QuotedMessage | undefined; // unverified
  /** `true` if the client buffered this message while Node was unreachable. */
  readonly replayed: boolean;
  /** Client-specific fields with no portable equivalent. Not covered by semver. */
  readonly raw: Readonly<Record<string, unknown>>;

  /** Sends to the room of this message. With `{ quote: true }`, sends a KakaoTalk reply to this message. */
  reply(content: Sendable, options?: ReplyOptions): Promise<SendResult>;
  /** Marks the room of this message as read. */
  markRead(options?: RequestOptions): Promise<void>;
  toJSON(): MessageData;
}

/** Message that another message quotes. */
export interface QuotedMessage {
  // unverified
  readonly id: MessageId;
  readonly text: string;
  readonly sender: User | undefined;
}

/** File attached to a message. */
export interface Attachment {
  // unverified
  readonly type: "photo" | "video" | "audio" | "file" | "emoticon";
  readonly name: string | undefined;
  readonly mimeType: string | undefined;
  readonly size: number | undefined;
  /** Downloads the file through the device. */
  fetch(options?: RequestOptions): Promise<Blob>; // unverified
}

/** Options for sending a message. */
export interface SendOptions extends RequestOptions {
  /** Message to reply to, as a KakaoTalk reply. Requires `send.quote`. */
  quote?: Message; // unverified
}

/** Options for replying to a message. */
export interface ReplyOptions extends RequestOptions {
  /** Whether to send a KakaoTalk reply to the message. Requires `send.quote`. Default `false`. */
  quote?: boolean; // unverified
}

/** Options for reading the history of a room. */
export interface HistoryOptions extends RequestOptions {
  // unverified
  /** Only messages older than this message, or than the message with this id. */
  before?: Message | MessageId;
  /** Maximum number of messages. Default `50`. */
  limit?: number;
}

/** Options for waiting for the next message of a room. */
export interface NextMessageOptions extends WaitOptions<Message> {
  /** Only messages from this user, or from the user with this id. */
  from?: User | UserId;
}

/** Built-in events, with the payload of each. */
export interface RemoteKakaoEvents {
  /** A message arrived. This includes messages the client buffered while Node was unreachable. */
  message: Message;
  /** A session with a device started. */
  deviceConnect: Device;
  /** A session with a device ended. */
  deviceDisconnect: DeviceDisconnect;
  /** An error that has no call to be thrown from. If there is no listener, it is logged instead. */
  error: ErrorReport;
}

/** Payload of `deviceDisconnect`. */
export interface DeviceDisconnect {
  readonly device: Device;
  /** Why the session ended. `undefined` if either side said goodbye. */
  readonly error: RKError | undefined;
}

/** Payload of `error`. */
export interface ErrorReport {
  readonly error: unknown;
  /** Where the error came from. `listener`: a listener threw or rejected. `transport`: a link failed. */
  readonly source: "listener" | "plugin" | "device" | "transport";
  /** The event being handled, if the error came from a listener. */
  readonly event: EventName | undefined;
  readonly device: Device | undefined;
}

/**
 * Events sent by client-side extensions, by name (`namespace:event`).
 * Add entries by augmenting this interface: `"namespace:event": Data`.
 */
export interface ExtensionEvents {}

/** Payload of an extension event. */
export interface ExtensionEvent<T> {
  readonly device: Device;
  /** Account the event belongs to, if any. */
  readonly account: Account | undefined;
  readonly data: T;
}

/** Every event: the built-in ones, and the extension events that have been typed. */
export type EventMap = RemoteKakaoEvents & {
  [K in keyof ExtensionEvents as K extends `${string}:${string}` ? K : never]: ExtensionEvent<
    ExtensionEvents[K]
  >;
};

/** Name of a typed event. */
export type EventName = keyof EventMap & string;

/** Payload of the event `E`. */
export type EventPayload<E extends EventName> = EventMap[E];

/** Function that receives the payload of the event `E`. */
export type Listener<E extends EventName> = (payload: EventPayload<E>) => unknown;
