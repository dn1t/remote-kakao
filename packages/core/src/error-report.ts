import type { Emitter } from "./emitter.ts";
import type { ErrorReport, Logger } from "./types.ts";

/**
 * Makes the function that reports errors that have no call to be thrown from.
 * An error goes to the listeners of `error`, or to the logger if there are none.
 */
export function createErrorReporter(
  emitter: Emitter,
  logger: Logger,
): (report: ErrorReport) => void {
  return (report) => {
    // An `error` listener that throws is only logged. Emitting it again could loop forever.
    const fromErrorListener = report.source === "listener" && report.event === "error";
    if (!fromErrorListener && emitter.has("error")) {
      void emitter.emit("error", report);
      return;
    }
    logger.error(`unhandled ${report.source} error`, {
      error: report.error,
      ...(report.event === undefined ? {} : { event: report.event }),
      ...(report.device === undefined ? {} : { device: report.device.id }),
    });
  };
}
