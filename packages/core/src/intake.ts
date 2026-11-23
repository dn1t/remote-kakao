import type { SessionKeys, SessionState } from "./device.ts";
import type { ClientFrame, DeviceId } from "./protocol.ts";
import type { OpenedFrame } from "./seal.ts";
import { deriveKey, Direction, openFrame, peekHeader } from "./seal.ts";

/** Finds the token of a device by its id. Resolves with `undefined` if the device has none. */
export type TokenLookup = (device: DeviceId) => Promise<string | undefined>;

/** A frame from the device that opened, and passed every check that does not need to know what it says. */
export interface IncomingFrame extends OpenedFrame {
  frame: ClientFrame;
}

/** What to do with bytes that arrived on a link. */
export type Intake =
  /** The link cannot be trusted. Close it. */
  | { kind: "close"; code: "AUTH_FAILED" | "PROTOCOL_ERROR"; reason: string }
  /** Throw the bytes away and keep the link. */
  | { kind: "ignore"; reason: string }
  /** The frame is good. `keys` are those of the session, or those the frame's device would get if it is a hello. */
  | { kind: "frame"; incoming: IncomingFrame; keys: SessionKeys | undefined };

const CLIENT_FRAME_TYPES: ReadonlySet<string> = new Set<ClientFrame["t"]>([
  "hello",
  "event",
  "req",
  "res",
  "ping",
  "pong",
  "bye",
]);

/**
 * Checks the bytes of a frame that arrived on a link, and opens it.
 *
 * A sealed frame is opened with the keys of the session. The first frame of a link has no
 * session yet, so it is opened with keys made from the token of the device named in the frame.
 * `tokenOf` finds that token, and is `undefined` when `auth` is off, where frames are plain.
 * Rejects if `tokenOf` does.
 *
 * What happens to a frame that is invalid depends on the link:
 * - Without a session, the link is closed.
 * - With a session, the frame is ignored. Invalid frames are not authenticated, so if they
 *   closed the link, anyone who can send bytes to it could end the session.
 */
export async function intake(
  raw: Uint8Array,
  tokenOf: TokenLookup | undefined,
  session: SessionState | undefined,
): Promise<Intake> {
  const header = peekHeader(raw);
  const sealedMode = tokenOf !== undefined;
  const refuse = (code: "AUTH_FAILED" | "PROTOCOL_ERROR", reason: string): Intake =>
    session === undefined ? { kind: "close", code, reason } : { kind: "ignore", reason };

  if (header === undefined) return refuse("PROTOCOL_ERROR", "malformed frame");
  if (header.direction !== Direction.Up)
    return refuse("PROTOCOL_ERROR", "frame going the wrong way");
  if (header.sealed !== sealedMode) {
    return sealedMode
      ? refuse("AUTH_FAILED", "expected a sealed frame")
      : refuse("PROTOCOL_ERROR", "unexpected sealed frame");
  }

  let keys = session?.keys;
  if (session !== undefined) {
    if (header.device !== session.device)
      return { kind: "ignore", reason: "frame of another device" };
    if (keys !== undefined && !Buffer.from(keys.salt).equals(header.salt)) {
      return { kind: "ignore", reason: "frame of another session" };
    }
  } else if (sealedMode) {
    const token = await tokenOf(header.device);
    if (token === undefined || token === "")
      return refuse("AUTH_FAILED", "no token for the device");
    keys = {
      salt: header.salt,
      up: deriveKey(token, header.salt, Direction.Up),
      down: deriveKey(token, header.salt, Direction.Down),
    };
  }

  const opened = openFrame(raw, keys?.up);
  if (opened === undefined) return { kind: "ignore", reason: "frame did not open" };
  if (!isClientFrame(opened))
    return { kind: "ignore", reason: `unexpected ${opened.frame.t} frame` };
  if (session !== undefined && opened.sealed && !session.acceptCounter(opened.counter)) {
    return { kind: "ignore", reason: "frame counter already used or too old" };
  }
  return { kind: "frame", incoming: opened, keys };
}

function isClientFrame(opened: OpenedFrame): opened is IncomingFrame {
  return CLIENT_FRAME_TYPES.has(opened.frame.t);
}
