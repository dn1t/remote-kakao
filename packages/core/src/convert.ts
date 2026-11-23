import type {
  AppInstanceId,
  Capability,
  DeviceId,
  RoomId,
  WireBlob,
  WireContent,
} from "./protocol.ts";
import type { Sendable } from "./types.ts";

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

const DEFAULT_MIME = "application/octet-stream";

/** Content to send on the wire, and the capabilities the device needs for it. */
export interface PreparedContent {
  content: WireContent;
  required: readonly Capability[];
}

/**
 * Turns what the user wants to send into what goes over the wire.
 * Throws a `TypeError` if the content is empty, has no `name` for a file, or is none of the kinds.
 */
export async function prepareContent(content: Sendable): Promise<PreparedContent> {
  if (typeof content === "string") return text(content);
  const value: unknown = content;
  if (typeof value !== "object" || value === null) {
    throw new TypeError("content must be a string or an object");
  }

  const kinds = (["text", "image", "file"] as const).filter((kind) => kind in content);
  if (kinds.length === 0) throw new TypeError("content must have `text`, `image` or `file`");
  if (kinds.length > 1)
    throw new TypeError("content must have only one of `text`, `image`, `file`");

  if ("text" in content) return text(content.text);
  if ("image" in content) {
    const image = await toWireBlob(content.image);
    return {
      content: content.caption === undefined ? { image } : { image, caption: content.caption },
      required: ["room.send", "send.image"],
    };
  }
  if (typeof content.name !== "string" || content.name.length === 0) {
    throw new TypeError("a file needs a `name`");
  }
  return {
    content: { file: await toWireBlob(content.file), name: content.name },
    required: ["room.send", "send.file"],
  };
}

function text(value: unknown): PreparedContent {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("text must be a non-empty string");
  }
  return { content: { text: value }, required: ["room.send"] };
}

/** Bytes without a type are sent as `application/octet-stream`. */
async function toWireBlob(data: Blob | Uint8Array): Promise<WireBlob> {
  if (data instanceof Uint8Array) {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return { mime: DEFAULT_MIME, base64: bytes.toString("base64") };
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  return { mime: data.type || DEFAULT_MIME, base64: bytes.toString("base64") };
}

/** Turns data from the wire into a `Blob`. Returns `undefined` if there is none. */
export function wireBlobToBlob(blob: WireBlob | undefined): Blob | undefined {
  if (!blob) return undefined;
  return new Blob([Buffer.from(blob.base64, "base64")], { type: blob.mime });
}
