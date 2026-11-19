// will move to `@remote-kakao/protocol` later

export const PROTOCOL_VERSION = 1 as const;

/**
 * What a client can do. Extensions use `namespace:name`.\
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
  | "message.own" // unverified
  | "message.mentions" // unverified
  | "message.attachments" // unverified
  | "message.quotes" // unverified
  | `${string}:${string}`;

/**
 * Type of the message.\
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
