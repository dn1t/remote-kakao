import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

import type { AnyFrame, DeviceId } from "./protocol.ts";

/** The direction a frame travels. */
export const Direction = {
  /** Device to Node. */
  Up: 0,
  /** Node to device. */
  Down: 1,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

const VERSION_PLAIN = 0x00;
const VERSION_SEALED = 0x01;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const COUNTER_LENGTH = 8;
const TAG_LENGTH = 16;
const NONCE_LENGTH = 12;
const MAX_DEVICE_ID_LENGTH = 255;
const INFO_UP = Buffer.from("rk wire v1 up");
const INFO_DOWN = Buffer.from("rk wire v1 down");

/**
 * Derives the key for one direction of a session from the shared token.
 * HKDF-SHA256 with the token as input, the session salt as salt, and a fixed label per direction.
 */
export function deriveKey(token: string, salt: Uint8Array, direction: Direction): Buffer {
  const info = direction === Direction.Up ? INFO_UP : INFO_DOWN;
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), salt, info, KEY_LENGTH));
}

/** Device and direction of a frame. Both stay readable without the key. */
export interface PlainParams {
  direction: Direction;
  device: DeviceId;
}

/** Params needed to seal a frame. */
export interface SealedParams extends PlainParams {
  /** 16 random bytes chosen by the client for the session. */
  salt: Uint8Array;
  /** Number of the frame in this session and direction, starting at 0. Never use a counter twice. */
  counter: bigint;
  /** The key of this direction, from `deriveKey`. */
  key: Uint8Array;
}

/**
 * Turns a frame into bytes.
 *
 * Sealed layout, in bytes: version `0x01` (1), direction (1), device id length (1), device id,
 * salt (16), counter (8, big-endian), AES-256-GCM ciphertext, tag (16).
 * Everything before the ciphertext stays readable but is authenticated, so it cannot be changed.
 *
 * Without a key (`auth: false`) the frame is plain: version `0x00`, direction, device id length,
 * device id, JSON.
 */
export function sealFrame(frame: AnyFrame, params: PlainParams | SealedParams): Uint8Array {
  const deviceBytes = Buffer.from(params.device, "utf8");
  if (deviceBytes.length > MAX_DEVICE_ID_LENGTH) {
    throw new RangeError(`device id is longer than ${MAX_DEVICE_ID_LENGTH} bytes`);
  }
  const json = Buffer.from(JSON.stringify(frame), "utf8");

  if (!("key" in params)) {
    return Buffer.concat([header(VERSION_PLAIN, params.direction, deviceBytes), json]);
  }

  const { direction, salt, counter, key } = params;
  if (salt.length !== SALT_LENGTH) throw new RangeError(`salt must be ${SALT_LENGTH} bytes`);
  const counterBytes = Buffer.alloc(COUNTER_LENGTH);
  counterBytes.writeBigUInt64BE(counter);

  const aad = Buffer.concat([header(VERSION_SEALED, direction, deviceBytes), salt, counterBytes]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce(counter));
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  return Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
}

function header(version: number, direction: Direction, deviceBytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from([version, direction, deviceBytes.length]), deviceBytes]);
}

/** Four zero bytes, then the counter. A key never sees the same counter twice, so nonces never repeat. */
function nonce(counter: bigint): Buffer {
  const bytes = Buffer.alloc(NONCE_LENGTH);
  bytes.writeBigUInt64BE(counter, NONCE_LENGTH - COUNTER_LENGTH);
  return bytes;
}

/** Part of a frame the receiver can read without decrypting. */
export interface FrameHeader {
  /** `false` for a plain frame (`auth: false`). */
  sealed: boolean;
  direction: Direction;
  device: DeviceId;
  /** Empty for a plain frame. */
  salt: Uint8Array;
}

/** Frame read from bytes. */
export interface OpenedFrame extends FrameHeader {
  /** `0n` for a plain frame, which has no counter. */
  counter: bigint;
  frame: AnyFrame;
}

/**
 * Reads the device, direction and salt of a frame without decrypting it.
 * The receiver needs them to pick the key before it can open the frame.
 * Returns `undefined` if the bytes are not a frame.
 */
export function peekHeader(bytes: Uint8Array): FrameHeader | undefined {
  const header = readHeader(view(bytes));
  if (!header) return undefined;
  const { sealed, direction, device, salt } = header;
  return { sealed, direction, device, salt };
}

/**
 * Reads a frame from bytes. Returns `undefined` if the bytes are not a valid frame,
 * or, if sealed, were changed or sealed with another key.
 *
 * Pass the key of the direction the frame came in for a sealed frame, or no key for a plain frame.
 * A frame of the other kind is refused, so a plain frame cannot slip in where a sealed one is due.
 * It throws if the key is not 32 bytes.
 */
export function openFrame(bytes: Uint8Array, key?: Uint8Array): OpenedFrame | undefined {
  if (key !== undefined && key.length !== KEY_LENGTH) {
    throw new RangeError(`key must be ${KEY_LENGTH} bytes`);
  }
  const buf = view(bytes);
  const header = readHeader(buf);
  if (!header || header.sealed !== (key !== undefined)) return undefined;
  const { sealed, direction, device, salt, end } = header;

  if (key === undefined) {
    const frame = parseFrame(buf.subarray(end));
    return frame && { sealed, direction, device, salt, counter: 0n, frame };
  }

  const cipherStart = end + COUNTER_LENGTH;
  if (buf.length < cipherStart + TAG_LENGTH) return undefined;
  const counter = buf.readBigUInt64BE(end);
  let json: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce(counter));
    decipher.setAAD(buf.subarray(0, cipherStart));
    decipher.setAuthTag(buf.subarray(buf.length - TAG_LENGTH));
    const plain = decipher.update(buf.subarray(cipherStart, buf.length - TAG_LENGTH));
    json = Buffer.concat([plain, decipher.final()]);
  } catch {
    return undefined;
  }
  const frame = parseFrame(json);
  return frame && { sealed, direction, device, salt, counter, frame };
}

/** Frame types the receiver knows. A frame of any other type is refused. */
const FRAME_TYPES: Record<AnyFrame["t"], true> = {
  hello: true,
  welcome: true,
  reject: true,
  idle: true,
  ping: true,
  pong: true,
  bye: true,
  event: true,
  ack: true,
  req: true,
  res: true,
};

// `ignoreBOM` keeps a leading U+FEFF, so a device id reads back exactly as it was written.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function view(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

interface ParsedHeader extends FrameHeader {
  /** Where the header ends in the bytes. */
  end: number;
}

function readHeader(buf: Buffer): ParsedHeader | undefined {
  if (buf.length < 3) return undefined;
  const version = buf[0]!;
  const direction = buf[1]!;
  const idEnd = 3 + buf[2]!;
  if (version !== VERSION_PLAIN && version !== VERSION_SEALED) return undefined;
  if (direction !== Direction.Up && direction !== Direction.Down) return undefined;
  if (buf.length < idEnd) return undefined;
  let device: string;
  try {
    device = utf8.decode(buf.subarray(3, idEnd));
  } catch {
    return undefined;
  }

  if (version === VERSION_PLAIN) {
    return { sealed: false, direction, device, salt: new Uint8Array(0), end: idEnd };
  }
  const end = idEnd + SALT_LENGTH;
  if (buf.length < end) return undefined;
  const salt = new Uint8Array(buf.subarray(idEnd, end));
  return { sealed: true, direction, device, salt, end };
}

function parseFrame(json: Uint8Array): AnyFrame | undefined {
  try {
    const value: unknown = JSON.parse(utf8.decode(json));
    if (typeof value !== "object" || value === null) return undefined;
    const type = (value as { t?: unknown }).t;
    if (typeof type !== "string" || !Object.hasOwn(FRAME_TYPES, type)) return undefined;
    return value as AnyFrame;
  } catch {
    return undefined;
  }
}
