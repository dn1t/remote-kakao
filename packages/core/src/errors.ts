import type { Device } from "./types.ts";

/** Errors thrown from the call that failed. */
export type RKCallErrorCode =
  | "TIMEOUT"
  | "DEVICE_OFFLINE"
  | "ABORTED"
  | "CLOSED"
  | "UNSUPPORTED"
  | "NOT_FOUND"
  | "UNREACHABLE"
  | "REJECTED"
  | "CLIENT_ERROR";

/**
 * Errors that happen while a device connects, when no call is waiting.
 * They are reported through `deviceDisconnect` and `error`, never thrown from a call.
 */
export type RKConnectionErrorCode = "AUTH_FAILED" | "PROTOCOL_MISMATCH" | "PROTOCOL_ERROR";

/** Every error code. */
export type RKErrorCode = RKCallErrorCode | RKConnectionErrorCode;

/** Codes where the same call may succeed later without changes. */
const RETRYABLE: ReadonlySet<RKErrorCode> = new Set<RKErrorCode>([
  "TIMEOUT",
  "DEVICE_OFFLINE",
  "UNREACHABLE",
]);

/** Options for creating an `RKError`. */
export interface RKErrorOptions {
  cause?: unknown;
  device?: Device;
  /** Override the default retryability for the code. */
  retryable?: boolean;
}

/** The error type for everything remote-kakao reports. */
export class RKError extends Error {
  override readonly name = "RKError";
  readonly code: RKErrorCode;
  /** The same call may succeed later without changes. */
  readonly retryable: boolean;
  readonly device: Device | undefined;

  constructor(code: RKErrorCode, message: string, options: RKErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.device = options.device;
  }
}

/** Narrows `error` to `RKError`, optionally only for a specific `code`. */
export function isRKError(error: unknown, code?: RKErrorCode): error is RKError {
  return error instanceof RKError && (code === undefined || error.code === code);
}
