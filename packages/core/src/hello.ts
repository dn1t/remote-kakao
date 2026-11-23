import type { RKConnectionErrorCode } from "./errors.ts";
import type { DeviceId, Hello, Reject, WireAppInstance } from "./protocol.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import type { SaltCache } from "./salt-cache.ts";
import type { AppInstanceData, DeviceHello } from "./types.ts";

/** How far, in ms, the clock of a device may differ from ours. A `hello` outside it is refused. */
export const MAX_CLOCK_SKEW = 120_000;

/**
 * How long, in ms, the salt of an accepted `hello` is remembered.
 * It has to be more than twice `MAX_CLOCK_SKEW`: that is how long a recorded `hello` keeps passing the clock check.
 */
export const SALT_TTL = 600_000;

/** The longest session budget, in ms, that `setTimeout` can wait out. */
const MAX_BUDGET = 2 ** 31 - 1;

/** What to do with a `hello`. */
export type HelloVerdict =
  | { accepted: true }
  | {
      accepted: false;
      /** Why the link is closed. */
      code: RKConnectionErrorCode;
      /** For the log. */
      reason: string;
      /** Sent to the device before the link is closed. Missing when the device is told nothing. */
      reject: Reject | undefined;
    };

/** What `checkHello` needs to know about where the `hello` came from, and how to check it. */
export interface HelloContext {
  /** The device named in the header of the frame that held the `hello`. */
  device: DeviceId;
  /** The salt of that frame. Empty for a plain frame. */
  salt: Uint8Array;
  transport: string;
  remoteAddress: string;
  saltCache: SaltCache;
  /** The `auth.verify` option. `undefined` if there is none, or `auth` is off. */
  verify: ((hello: DeviceHello) => boolean | Promise<boolean>) | undefined;
  /** Called when `verify` throws or rejects. The `hello` is then refused. */
  onVerifyError(error: unknown): void;
}

/**
 * Decides whether to accept the `hello` that starts a session.
 *
 * Checks, in this order: that its salt is new, the protocol version, the shape of the `hello`,
 * that it is from the device that sealed it, that the clock of the device is close to ours, and `verify`.
 *
 * The salt is checked first, and used up even if the `hello` is then refused.
 * Node answers a `hello` with a `reject` or a `welcome`, and seals either with counter 0
 * under the keys made from the salt. Two different frames sealed with the same key and counter
 * would leak their contents, so a salt may be answered only once.
 *
 * A refusal is answered with a `reject`, except for a malformed `hello` and a repeated salt.
 * A repeated salt means the frame was recorded and sent again, so the sender is told nothing.
 */
export async function checkHello(hello: Hello, context: HelloContext): Promise<HelloVerdict> {
  if (context.salt.length > 0 && !context.saltCache.add(context.salt)) {
    return refuse("AUTH_FAILED", "replayed session salt", undefined);
  }
  if (hello.v !== PROTOCOL_VERSION) {
    return refuse("PROTOCOL_MISMATCH", "version mismatch", {
      t: "reject",
      code: "PROTOCOL_MISMATCH",
      message: `server speaks v${PROTOCOL_VERSION}`,
    });
  }
  const problem = helloProblem(hello);
  if (problem !== undefined) return refuse("PROTOCOL_ERROR", problem, undefined);

  if (hello.device.id !== context.device) {
    return refuse("AUTH_FAILED", "hello is from another device than the frame", {
      t: "reject",
      code: "AUTH_FAILED",
      message: "device id does not match the frame",
    });
  }
  if (Math.abs(Date.now() - hello.ts) > MAX_CLOCK_SKEW) {
    return refuse("AUTH_FAILED", "hello timestamp out of range", {
      t: "reject",
      code: "AUTH_FAILED",
      message: `clock differs from the server by more than ${MAX_CLOCK_SKEW / 60_000} minutes`,
    });
  }
  if (context.verify !== undefined) {
    let allowed = false;
    try {
      allowed = await context.verify(toDeviceHello(hello, context));
    } catch (error) {
      context.onVerifyError(error);
    }
    if (!allowed) {
      return refuse("AUTH_FAILED", "verify rejected the device", {
        t: "reject",
        code: "AUTH_FAILED",
        message: "rejected by verify",
      });
    }
  }
  return { accepted: true };
}

/** What `auth.verify` is given: the `hello`, in the public types. */
export function toDeviceHello(
  hello: Hello,
  source: { transport: string; remoteAddress: string },
): DeviceHello {
  return {
    device: hello.device,
    client: hello.client,
    protocolVersion: hello.v,
    capabilities: hello.caps,
    appInstances: hello.appInstances.map(appInstanceData),
    budget: hello.budget,
    transport: source.transport,
    remoteAddress: source.remoteAddress,
  };
}

function appInstanceData(wire: WireAppInstance): AppInstanceData {
  return {
    id: wire.id,
    ...(wire.me === undefined ? {} : { me: { id: wire.me.id, name: wire.me.name } }),
  };
}

function refuse(
  code: RKConnectionErrorCode,
  reason: string,
  reject: Reject | undefined,
): HelloVerdict {
  return { accepted: false, code, reason, reject };
}

/** Describes what is wrong with the shape of the `hello`, or returns `undefined` if nothing is. */
function helloProblem(hello: Hello): string | undefined {
  const value = hello as unknown as Record<string, unknown>;
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return "hello has no valid ts";
  if (!hasStrings(value.device, ["id", "name", "platform"])) return "hello has no valid device";
  if (!hasStrings(value.client, ["name", "version"])) return "hello has no valid client";
  if (!Array.isArray(value.caps) || !value.caps.every((cap) => typeof cap === "string")) {
    return "hello has no valid caps";
  }
  if (!Array.isArray(value.appInstances) || !value.appInstances.every(isAppInstance)) {
    return "hello has no valid appInstances";
  }
  const budget = value.budget;
  if (budget !== undefined && !(typeof budget === "number" && budget > 0 && budget <= MAX_BUDGET)) {
    return "hello has no valid budget";
  }
  return undefined;
}

function hasStrings(value: unknown, keys: string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  return keys.every((key) => typeof (value as Record<string, unknown>)[key] === "string");
}

function isAppInstance(value: unknown): boolean {
  if (!hasStrings(value, ["id"])) return false;
  const me = (value as { me?: unknown }).me;
  return me === undefined || hasStrings(me, ["id", "name"]);
}
