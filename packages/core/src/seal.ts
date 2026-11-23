import { hkdfSync } from "node:crypto";

/** The direction a frame travels. */
export const Direction = {
  /** Device to Node. */
  Up: 0,
  /** Node to device. */
  Down: 1,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

const KEY_LENGTH = 32;
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
