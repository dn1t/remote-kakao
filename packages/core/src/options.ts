import { timeoutError } from "./device.ts";
import { resolveLogger } from "./logger.ts";
import type { AuthOptions, Logger, RemoteKakaoOptions, Transport } from "./types.ts";

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL = 10_000;

/** `RemoteKakaoOptions` checked, with the defaults filled in. */
export interface ResolvedOptions {
  transports: readonly Transport[];
  auth: AuthOptions | false;
  requestTimeout: number;
  heartbeat: { interval: number; timeout: number };
  logger: Logger;
}

/**
 * Checks the options and fills in the defaults.
 * Throws a `TypeError` for a missing or wrongly typed option, and a `RangeError` for a number out of range.
 */
export function resolveOptions(options: RemoteKakaoOptions): ResolvedOptions {
  if (typeof options !== "object" || options === null) throw new TypeError("options are required");
  const { transports, auth } = options;

  if (!Array.isArray(transports) || transports.length === 0) {
    throw new TypeError("`transports` needs at least one transport");
  }
  for (const transport of transports as unknown[]) {
    if (!isTransport(transport)) {
      throw new TypeError("every transport needs a `name` and a `listen` function");
    }
  }
  if ((auth as unknown) === undefined) {
    throw new TypeError("`auth` is required; pass `auth: false` to turn authentication off");
  }
  if (auth !== false) checkAuth(auth);

  const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const invalid = timeoutError(requestTimeout, "requestTimeout");
  if (invalid) throw invalid;

  const interval = options.heartbeat?.interval ?? DEFAULT_HEARTBEAT_INTERVAL;
  const timeout = options.heartbeat?.timeout ?? interval * 3;
  for (const [value, name] of [
    [interval, "heartbeat.interval"],
    [timeout, "heartbeat.timeout"],
  ] as const) {
    const error = timeoutError(value, name);
    if (error) throw error;
    if (value === 0) throw new RangeError(`${name} must be more than 0`);
  }
  if (timeout <= interval) {
    throw new RangeError("heartbeat.timeout must be longer than heartbeat.interval");
  }

  return {
    transports: [...transports],
    auth,
    requestTimeout,
    heartbeat: { interval, timeout },
    logger: resolveLogger(options.logger),
  };
}

function isTransport(value: unknown): value is Transport {
  if (typeof value !== "object" || value === null) return false;
  const { name, listen } = value as Partial<Transport>;
  return typeof name === "string" && typeof listen === "function";
}

function checkAuth(auth: AuthOptions): void {
  if (typeof auth !== "object" || auth === null) {
    throw new TypeError("`auth` must be an object, or `false`");
  }
  const { token, verify } = auth as { token: unknown; verify: unknown };
  if (typeof token !== "function" && (typeof token !== "string" || token.length === 0)) {
    throw new TypeError("`auth.token` must be a non-empty string or a function");
  }
  if (verify !== undefined && typeof verify !== "function") {
    throw new TypeError("`auth.verify` must be a function");
  }
}
