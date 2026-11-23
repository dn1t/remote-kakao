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
  WireRoom,
  WireUser,
} from "./protocol.ts";
import type {
  RequestOptions,
  RoomData,
  Sendable,
  SendOptions,
  SendResult,
  UserData,
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

/** A KakaoTalk app on a device. */
export class AppInstanceImpl {
  readonly id: AppInstanceId;
  readonly device: DeviceState;
  /** The user the app instance is signed in as, if the client can tell. Set when the client says hello. */
  me: UserImpl | undefined;

  constructor(device: DeviceState, id: AppInstanceId) {
    this.device = device;
    this.id = id;
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
export class UserImpl {
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
export class RoomImpl {
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
