import { encodeRef, prepareContent, wireBlobToBlob } from "./convert.ts";
import type { DeviceState } from "./device.ts";
import { RKError } from "./errors.ts";
import type {
  AppInstanceId,
  Capability,
  MessageId,
  RoomId,
  RoomType,
  UserId,
  WireAttachment,
  WireMessage,
  WireRoom,
  WireUser,
} from "./protocol.ts";
import type {
  AppInstance,
  Attachment,
  AttachmentData,
  HistoryOptions,
  IterateOptions,
  Message,
  MessageData,
  NextMessageOptions,
  QuotedMessage,
  ReplyOptions,
  RequestOptions,
  Room,
  RoomData,
  Sendable,
  SendOptions,
  SendResult,
  User,
  UserData,
  WaitOptions,
} from "./types.ts";

/**
 * Throws `UNSUPPORTED` if the device is known not to support the capability.
 * A device that has not connected yet has no capabilities on record, so the call is let through
 * and the device answers it.
 */
export function requireCapability(device: DeviceState, capability: Capability): void {
  if (device.described && !device.supports(capability)) {
    throw new RKError("UNSUPPORTED", `device does not support "${capability}"`, { device });
  }
}

/** The stream of messages from all devices, which rooms read to wait for and iterate over messages. */
export interface MessageStream {
  wait(options: WaitOptions<Message>): Promise<Message>;
  iterate(options: IterateOptions<Message>): AsyncIterableIterator<Message>;
}

/** A KakaoTalk app on a device. */
export class AppInstanceImpl implements AppInstance {
  readonly id: AppInstanceId;
  readonly device: DeviceState;
  /** The user the app instance is signed in as, if the client can tell. Set when the client says hello. */
  me: UserImpl | undefined;
  readonly messages: MessageStream;

  constructor(device: DeviceState, id: AppInstanceId, messages: MessageStream) {
    this.device = device;
    this.id = id;
    this.messages = messages;
  }

  /** The room with the given id. Does not ask the device. */
  room(id: RoomId): RoomImpl {
    return new RoomImpl(this, { id });
  }

  /** Asks the device for its rooms. */
  async rooms(options?: RequestOptions): Promise<RoomImpl[]> {
    requireCapability(this.device, "room.list");
    const { rooms } = await this.device.request("room.list", { appInstance: this.id }, options);
    return rooms.map((wire) => new RoomImpl(this, wire));
  }
}

/** A KakaoTalk user, as seen from one app instance. */
export class UserImpl implements User {
  readonly id: UserId;
  readonly name: string;
  readonly appInstance: AppInstanceImpl;

  constructor(appInstance: AppInstanceImpl, wire: WireUser) {
    this.appInstance = appInstance;
    this.id = wire.id;
    this.name = wire.name;
  }

  /** Whether this is the user the app instance is signed in as. `false` when that user is not known. */
  get isMe(): boolean {
    return this.appInstance.me?.id === this.id;
  }

  async avatar(options?: RequestOptions): Promise<Blob | undefined> {
    const { device, id } = this.appInstance;
    requireCapability(device, "user.avatar");
    const { image } = await device.request(
      "user.avatar",
      { appInstance: id, user: this.id },
      options,
    );
    return wireBlobToBlob(image);
  }

  toJSON(): UserData {
    return { id: this.id, name: this.name };
  }
}

/** A chat room of an app instance. */
export class RoomImpl implements Room {
  readonly id: RoomId;
  readonly appInstance: AppInstanceImpl;
  /** `undefined` until the device has described the room. */
  readonly name: string | undefined;
  /** `undefined` until the device has described the room. */
  readonly isGroup: boolean | undefined;
  /** `"unknown"` until the device has described the room. */
  readonly type: RoomType;

  constructor(appInstance: AppInstanceImpl, wire: WireRoom) {
    this.appInstance = appInstance;
    this.id = wire.id;
    this.name = wire.name;
    this.isGroup = wire.isGroup;
    this.type = wire.type ?? "unknown";
  }

  get device(): DeviceState {
    return this.appInstance.device;
  }

  /** Encodes the device, app instance and room ids, so the same room can be found again later. */
  get ref(): string {
    return encodeRef({
      device: this.device.id,
      appInstance: this.appInstance.id,
      room: this.id,
    });
  }

  supports(capability: Capability): boolean {
    return this.device.supports(capability);
  }

  /**
   * Sends the content to the room, once the sends to the same room that were called earlier have finished.
   * The `timeout` in `options` counts from when the request is made, not from when `send` is called.
   */
  send(content: Sendable, options?: SendOptions): Promise<SendResult> {
    const { device } = this;
    return device.chainRoomSend(this.appInstance.id, this.id, async () => {
      const { content: wireContent, required } = await prepareContent(content);
      for (const capability of required) requireCapability(device, capability);
      let quote: MessageId | undefined;
      if (options?.quote !== undefined) {
        requireCapability(device, "send.quote");
        quote = options.quote.id;
      }
      const result = await device.request(
        "room.send",
        {
          appInstance: this.appInstance.id,
          room: this.id,
          content: wireContent,
          ...(quote === undefined ? {} : { quote }),
        },
        options,
      );
      return { messageId: result.messageId };
    });
  }

  async markRead(options?: RequestOptions): Promise<void> {
    requireCapability(this.device, "room.markRead");
    await this.device.request("room.markRead", this.#params(), options);
  }

  async icon(options?: RequestOptions): Promise<Blob | undefined> {
    requireCapability(this.device, "room.icon");
    const { image } = await this.device.request("room.icon", this.#params(), options);
    return wireBlobToBlob(image);
  }

  async members(options?: RequestOptions): Promise<UserImpl[]> {
    requireCapability(this.device, "room.members");
    const { users } = await this.device.request("room.members", this.#params(), options);
    return users.map((wire) => new UserImpl(this.appInstance, wire));
  }

  /** Asks the device for the messages of the room, newest first. */
  async history(options?: HistoryOptions): Promise<MessageImpl[]> {
    requireCapability(this.device, "room.history");
    const before = typeof options?.before === "string" ? options.before : options?.before?.id;
    const { messages } = await this.device.request(
      "room.history",
      {
        ...this.#params(),
        limit: options?.limit ?? 50,
        ...(before === undefined ? {} : { before }),
      },
      options,
    );
    return messages.map((wire) => new MessageImpl(this.appInstance, wire, false));
  }

  /** Waits for the next message in this room, from the given user if `options.from` is set. */
  nextMessage(options?: NextMessageOptions): Promise<Message> {
    const from = typeof options?.from === "string" ? options.from : options?.from?.id;
    const extra = options?.filter;
    return this.appInstance.messages.wait({
      ...timeoutAndSignal(options),
      filter: (message) =>
        message.room.ref === this.ref &&
        (from === undefined || message.sender.id === from) &&
        (extra === undefined || extra(message)),
    });
  }

  /** Iterates over the messages in this room as they arrive. */
  messages(options?: IterateOptions<Message>): AsyncIterableIterator<Message> {
    const extra = options?.filter;
    return this.appInstance.messages.iterate({
      ...options,
      filter: (message) => message.room.ref === this.ref && (extra === undefined || extra(message)),
    });
  }

  toJSON(): RoomData {
    return {
      ref: this.ref,
      id: this.id,
      appInstance: this.appInstance.id,
      device: this.device.id,
      type: this.type,
      ...(this.name === undefined ? {} : { name: this.name }),
      ...(this.isGroup === undefined ? {} : { isGroup: this.isGroup }),
    };
  }

  /** The params that identify this room in a request. */
  #params(): { appInstance: AppInstanceId; room: RoomId } {
    return { appInstance: this.appInstance.id, room: this.id };
  }
}

/** A file attached to a message. */
export class AttachmentImpl implements Attachment {
  readonly type: WireAttachment["type"];
  readonly name: string | undefined;
  readonly mimeType: string | undefined;
  readonly size: number | undefined;
  readonly #message: MessageImpl;
  /** Position in the attachments of the message. */
  readonly #index: number;

  constructor(message: MessageImpl, index: number, wire: WireAttachment) {
    this.#message = message;
    this.#index = index;
    this.type = wire.type;
    this.name = wire.name;
    this.mimeType = wire.mime;
    this.size = wire.size;
  }

  /** Downloads the file from the device. */
  async fetch(options?: RequestOptions): Promise<Blob> {
    const room = this.#message.room;
    requireCapability(room.device, "message.attachments");
    const { data } = await room.device.request(
      "attachment.fetch",
      {
        appInstance: room.appInstance.id,
        room: room.id,
        message: this.#message.id,
        index: this.#index,
      },
      options,
    );
    const blob = wireBlobToBlob(data);
    if (blob === undefined) {
      throw new RKError("CLIENT_ERROR", "device sent no data for the attachment", {
        device: room.device,
      });
    }
    return blob;
  }

  toJSON(): AttachmentData {
    return {
      type: this.type,
      ...(this.name === undefined ? {} : { name: this.name }),
      ...(this.mimeType === undefined ? {} : { mimeType: this.mimeType }),
      ...(this.size === undefined ? {} : { size: this.size }),
    };
  }
}

/** A message a device reported, which does not change afterwards. */
export class MessageImpl implements Message {
  readonly id: MessageId;
  readonly room: RoomImpl;
  readonly sender: UserImpl;
  readonly type: Message["type"];
  readonly text: string;
  readonly time: Date;
  readonly hasMentions: boolean;
  readonly mentions: readonly UserImpl[];
  readonly attachments: readonly AttachmentImpl[];
  readonly quoted: QuotedMessage | undefined;
  readonly replayed: boolean;
  readonly raw: Readonly<Record<string, unknown>>;

  constructor(appInstance: AppInstanceImpl, wire: WireMessage, replayed: boolean) {
    this.id = wire.id;
    this.room = new RoomImpl(appInstance, wire.room);
    this.sender = new UserImpl(appInstance, wire.sender);
    this.type = wire.type;
    this.text = wire.text;
    this.time = new Date(wire.time);
    this.mentions = (wire.mentions ?? []).map((user) => new UserImpl(appInstance, user));
    this.hasMentions = wire.hasMentions ?? this.mentions.length > 0;
    this.attachments = (wire.attachments ?? []).map(
      (attachment, index) => new AttachmentImpl(this, index, attachment),
    );
    this.quoted =
      wire.quoted === undefined
        ? undefined
        : {
            id: wire.quoted.id,
            text: wire.quoted.text,
            sender:
              wire.quoted.sender === undefined
                ? undefined
                : new UserImpl(appInstance, wire.quoted.sender),
          };
    this.replayed = replayed;
    this.raw = Object.freeze({ ...wire.raw });
  }

  /** Sends to the room of this message. With `quote: true`, as a KakaoTalk reply to this message. */
  reply(content: Sendable, options?: ReplyOptions): Promise<SendResult> {
    return this.room.send(content, {
      ...timeoutAndSignal(options),
      ...(options?.quote === true ? { quote: this } : {}),
    });
  }

  markRead(options?: RequestOptions): Promise<void> {
    return this.room.markRead(options);
  }

  toJSON(): MessageData {
    return {
      id: this.id,
      room: this.room.toJSON(),
      sender: this.sender.toJSON(),
      type: this.type,
      text: this.text,
      time: this.time.toISOString(),
      hasMentions: this.hasMentions,
      mentions: this.mentions.map((user) => user.toJSON()),
      attachments: this.attachments.map((attachment) => attachment.toJSON()),
      replayed: this.replayed,
      ...(this.quoted === undefined
        ? {}
        : {
            quoted: {
              id: this.quoted.id,
              text: this.quoted.text,
              ...(this.quoted.sender === undefined ? {} : { sender: this.quoted.sender.toJSON() }),
            },
          }),
    };
  }
}

/** Only the timeout and the signal of the options, to pass on to another call. */
function timeoutAndSignal(options: RequestOptions | undefined): RequestOptions {
  return {
    ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  };
}
