import type { AppInstanceId, DeviceId, RoomId } from "./protocol.ts";

/** The ids that identify a room across all devices. */
export interface RoomLocation {
  device: DeviceId;
  appInstance: AppInstanceId;
  room: RoomId;
}

/** Encodes the ids of a room into one URL-safe string, the `ref` of the room. */
export function encodeRef(location: RoomLocation): string {
  const { device, appInstance, room } = location;
  return Buffer.from(JSON.stringify([device, appInstance, room]), "utf8").toString("base64url");
}

/** Reads the ids from a `ref`. Returns `undefined` if `ref` was not made by `encodeRef`. */
export function decodeRef(ref: string): RoomLocation | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    if (!parsed.every((id) => typeof id === "string")) return undefined;
    const [device, appInstance, room] = parsed as [string, string, string];
    const location = { device, appInstance, room };
    // Accept only the exact text encodeRef makes, to ensure one room has one ref.
    return encodeRef(location) === ref ? location : undefined;
  } catch {
    return undefined;
  }
}
