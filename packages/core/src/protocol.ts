/**
 * Wire protocol v1
 *
 * will move to `@remote-kakao/protocol` later
 */

export const PROTOCOL_VERSION = 1 as const;

/**
 * What a client can do. Extensions use `namespace:name`.
 * `send.*` extend `room.send`; a client without `room.send` is read-only.
 *
 * `unverified`: not yet confirmed to work on any client.
 */
export type Capability =
  | "room.send"
  | "send.image" // unverified
  | "send.file" // unverified
  | "send.quote" // unverified
  | "room.markRead"
  | "room.icon"
  | "room.list" // unverified
  | "room.members" // unverified
  | "room.history" // unverified
  | "user.avatar"
  | "message.mentions" // unverified
  | "message.attachments" // unverified
  | "message.quotes" // unverified
  | `${string}:${string}`;

/**
 * Type of the message.
 *
 * `unverified`: not yet confirmed to work on any client.
 */
export type MessageType =
  | "text"
  | "photo"
  | "video"
  | "audio"
  | "emoticon"
  | "file"
  | "kakaolink"
  | "location"
  | "contact"
  | "system" // unverified
  | "unknown";

export type RoomType = "direct" | "group" | "open-direct" | "open-group" | "memo" | "unknown";

/** Identifies an account signed in on a client. */
export type AccountId = string;

/** Identifies a room. Unique within an account. */
export type RoomId = string;

/**
 * Identifies a user. Unique within an account.
 *
 * The value may be dependent on the client's platform,
 * so the same user can have different ids on different clients
 */
export type UserId = string;

/** Identifies a message. */
export type MessageId = string;

/** KakaoTalk user reported by a client. */
export interface WireUser {
  id: UserId;
  name: string;
}

/** KakaoTalk account signed in on a client. */
export interface WireAccount {
  id: AccountId;
  me?: WireUser;
}

/** Chat room reported by a client. */
export interface WireRoom {
  id: RoomId;
  name?: string;
  type?: RoomType;
  /** For clients that only know whether a room is a group, not its exact type. */
  isGroup?: boolean;
}

/** Metadata of an attachment. The data itself is fetched separately. */
export interface WireAttachment {
  type: "photo" | "video" | "audio" | "file" | "emoticon";
  name?: string;
  mime?: string;
  size?: number;
}

/** Message reported by a client. */
export interface WireMessage {
  id: MessageId;
  room: WireRoom;
  sender: WireUser;
  type: MessageType;
  /** For types other than "text", contains KakaoTalk's preview text (e.g. "사진"). */
  text: string;
  /** Epoch ms. */
  time: number;
  hasMentions?: boolean;
  mentions?: WireUser[]; // unverified
  attachments?: WireAttachment[]; // unverified
  quoted?: { id: MessageId; text: string; sender?: WireUser }; // unverified
  raw?: Record<string, unknown>;
}

/** Binary data carried inside a JSON frame. */
export interface WireBlob {
  mime: string;
  base64: string;
}

/**
 * Content to send to a room.
 * Text needs `room.send`. Images and files also need `send.image` or `send.file`.
 *
 * `unverified`: not yet confirmed to work on any client.
 * */
export type WireContent =
  | { text: string }
  | { image: WireBlob; caption?: string } // unverified
  | { file: WireBlob; name: string }; // unverified

/** Identifies a room */
interface RoomRef {
  account: AccountId;
  room: RoomId;
}

/**
 * Requests Node sends to a client, keyed by method name.
 * Each method is gated by the capability of the same name, except `attachment.fetch`.
 *
 * `unverified`: not yet confirmed to work on any client.
 */
export interface Methods {
  "room.send": {
    /** `quote` is the id of the message to reply to. Needs `send.quote`. */
    params: RoomRef & { content: WireContent; quote?: MessageId }; // unverified
    /**
     * `messageId` is omitted when the client can't tell the id of the sent message.
     * A successful response means the message was handed to KakaoTalk, not that it was actually sent.
     */
    result: { messageId?: MessageId }; // unverified
  };
  "room.markRead": { params: RoomRef; result: Record<string, never> };
  "room.icon": { params: RoomRef; result: { image?: WireBlob } };
  "room.list": { params: { account: AccountId }; result: { rooms: WireRoom[] } }; // unverified
  "room.members": { params: RoomRef; result: { users: WireUser[] } }; // unverified
  "room.history": {
    /** `before` is a message id. Pages go from newest to oldest. */
    params: RoomRef & { before?: MessageId; limit: number };
    result: { messages: WireMessage[] };
  }; // unverified
  "user.avatar": { params: { account: AccountId; user: UserId }; result: { image?: WireBlob } };
  /** Needs `message.attachments`. `index` is the position in `WireMessage.attachments`, starting at 0. */
  "attachment.fetch": {
    params: RoomRef & { message: MessageId; index: number };
    result: { data: WireBlob };
  }; // unverified
}

/**
 * Events the client sends to Node when something happens on the client, such as a new message.
 * Each key is an event name, and its value is the type of `data` in that event's frame.
 */
export interface Events {
  /** A message arrived. */
  message: WireMessage;
}

/** A built-in method, or an extension method named `namespace:name`. */
export type MethodName = keyof Methods | `${string}:${string}`;
/** A built-in event, or an extension event named `namespace:name`. */
export type EventName = keyof Events | `${string}:${string}`;

/** First frame of a session, sent by the client. Describes the client and what it can do. */
export interface Hello {
  t: "hello";
  /** Protocol version */
  v: number;
  /** Epoch ms, for replay protection */
  ts: number;
  device: { id: string; name: string; platform: string };
  client: { name: string; version: string };
  caps: Capability[];
  accounts: WireAccount[];
  /** Ms this session can last. Omitted for persistent clients. */
  budget?: number;
}

/** Node's answer to a `hello` accepted. */
export interface Welcome {
  t: "welcome";
  v: number;
  session: string;
  /** The longest gap (ms) the client may stay silent before sending a `ping`. Only for sessions without a budget. */
  heartbeat?: number;
}

/** Node's answer to a `hello` refused. */
export interface Reject {
  t: "reject";
  code: "AUTH_FAILED" | "PROTOCOL_MISMATCH";
  message: string;
}

/**
 * Node has nothing more to send and no listener is still running for this session.
 * A short-lived client can end the session now instead of waiting out its budget.
 */
export interface Idle {
  t: "idle";
}

/** Keep-alive for clients without a budget. The receiver answers with `pong`. */
export interface Ping {
  t: "ping";
}

/** Answer to `ping`. */
export interface Pong {
  t: "pong";
}

/** Ends the session. Either side may send it. */
export interface Bye {
  t: "bye";
  reason?: string;
}
