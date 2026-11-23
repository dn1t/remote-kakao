import type { Logger } from "./types.ts";

const PREFIX = "[remote-kakao]";

/** Logger used when none is given. Warnings and errors go to `console`, debug and info are dropped. */
export const defaultLogger: Logger = {
  debug() {},
  info() {},
  warn(message, context) {
    if (context === undefined) console.warn(`${PREFIX} ${message}`);
    else console.warn(`${PREFIX} ${message}`, context);
  },
  error(message, context) {
    if (context === undefined) console.error(`${PREFIX} ${message}`);
    else console.error(`${PREFIX} ${message}`, context);
  },
};

/** Logger that drops everything. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Picks the logger for the `logger` option: the default if omitted, a silent one for `false`. */
export function resolveLogger(option?: Logger | false): Logger {
  if (option === false) return silentLogger;
  return option ?? defaultLogger;
}
