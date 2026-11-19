/**
 * Wire protocol v1
 *
 * will move to `@remote-kakao/protocol` later
 */

export const PROTOCOL_VERSION = 1 as const;

/**
 * What a client can do. Extensions use `namespace:name`.
 *
 * `unverified`: not yet confirmed to work on any client.
 */
export type Capability =
  | "send.text"
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

/** KakaoTalk user reported by a client. */
export interface WireUser {
  id: string;
  name: string;
}

/** KakaoTalk account signed in on a client. */
export interface WireAccount {
  id: string;
  me?: WireUser;
}

/** Chat room reported by a client. */
export interface WireRoom {
  id: string;
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
  id: string;
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
  quoted?: { id: string; text: string; sender?: WireUser }; // unverified
  raw?: Record<string, unknown>;
}

/** Binary data carried inside a JSON frame. */
export interface WireBlob {
  mime: string;
  base64: string;
}

/**
 * Content to send to a room.
 * Needs `send.text`, `send.image` or `send.file` respectively.
 *
 * `unverified`: not yet confirmed to work on any client.
 * */
export type WireContent =
  | { text: string }
  | { image: WireBlob; caption?: string } // unverified
  | { file: WireBlob; name: string }; // unverified
