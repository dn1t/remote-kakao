import { createCipheriv, hkdfSync } from "node:crypto";

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
  deviceId: DeviceId;
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
  const deviceId = Buffer.from(params.deviceId, "utf8");
  if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
    throw new RangeError(`device id is longer than ${MAX_DEVICE_ID_LENGTH} bytes`);
  }
  const json = Buffer.from(JSON.stringify(frame), "utf8");

  if (!("key" in params)) {
    return Buffer.concat([header(VERSION_PLAIN, params.direction, deviceId), json]);
  }

  const { direction, salt, counter, key } = params;
  if (salt.length !== SALT_LENGTH) throw new RangeError(`salt must be ${SALT_LENGTH} bytes`);
  const counterBytes = Buffer.alloc(COUNTER_LENGTH);
  counterBytes.writeBigUInt64BE(counter);

  const aad = Buffer.concat([header(VERSION_SEALED, direction, deviceId), salt, counterBytes]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce(counter));
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  return Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
}

function header(version: number, direction: Direction, deviceId: Buffer): Buffer {
  return Buffer.concat([Buffer.from([version, direction, deviceId.length]), deviceId]);
}

/** Four zero bytes, then the counter. A key never sees the same counter twice, so nonces never repeat. */
function nonce(counter: bigint): Buffer {
  const bytes = Buffer.alloc(NONCE_LENGTH);
  bytes.writeBigUInt64BE(counter, NONCE_LENGTH - COUNTER_LENGTH);
  return bytes;
}
