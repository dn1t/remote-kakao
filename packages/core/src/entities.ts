import { wireBlobToBlob } from "./convert.ts";
import type { DeviceState } from "./device.ts";
import { RKError } from "./errors.ts";
import type { AppInstanceId, Capability, UserId, WireUser } from "./protocol.ts";
import type { RequestOptions, UserData } from "./types.ts";

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
