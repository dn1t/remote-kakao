import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Emitter } from "../src/emitter.ts";
import { createErrorReporter } from "../src/error-report.ts";
import type { Device, ErrorReport, Logger } from "../src/types.ts";

interface Logged {
  message: string;
  context: object | undefined;
}

/** A reporter wired the way `RemoteKakao` wires it, and the errors it logged. */
function setUp() {
  const logged: Logged[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error: (message, context) => logged.push({ message, context }),
  };
  const emitter: Emitter = new Emitter({
    onListenerError: (error, event) =>
      report({ error, source: "listener", event, device: undefined }),
    onDrop() {},
  });
  const report = createErrorReporter(emitter, logger);
  return { emitter, report, logged };
}

const device = { id: "phone" } as Device;
const reportOf = (overrides: Partial<ErrorReport> = {}): ErrorReport => ({
  error: new Error("boom"),
  source: "transport",
  event: undefined,
  device: undefined,
  ...overrides,
});

describe("createErrorReporter", () => {
  it("emits the report to the listeners of error, and does not log it", () => {
    const { emitter, report, logged } = setUp();
    const received: ErrorReport[] = [];
    emitter.on("error", (payload) => void received.push(payload));
    const error = reportOf({ source: "device", device });

    report(error);

    assert.deepEqual(received, [error]);
    assert.equal(received[0], error);
    assert.deepEqual(logged, []);
  });

  it("logs the report when nobody listens to error", () => {
    const { report, logged } = setUp();
    const error = new Error("boom");

    report(reportOf({ error }));

    assert.deepEqual(logged, [{ message: "unhandled transport error", context: { error } }]);
  });

  it("names where the error came from, and the event and device when there are some", () => {
    const { report, logged } = setUp();
    const error = new Error("boom");

    report(reportOf({ error, source: "listener", event: "message", device }));
    report(reportOf({ error, source: "plugin" }));

    assert.deepEqual(logged, [
      {
        message: "unhandled listener error",
        context: { error, event: "message", device: "phone" },
      },
      { message: "unhandled plugin error", context: { error } },
    ]);
  });

  it("reports an error from a listener of another event to the listeners of error", async () => {
    const { emitter, logged } = setUp();
    const received: ErrorReport[] = [];
    emitter.on("error", (payload) => void received.push(payload));
    const error = new Error("listener failed");
    emitter.on("message", () => {
      throw error;
    });

    await emitter.emit("message", {} as never);

    assert.deepEqual(
      received.map((r) => [r.error, r.source, r.event]),
      [[error, "listener", "message"]],
    );
    assert.deepEqual(logged, []);
  });

  it("only logs an error thrown by a listener of error, instead of emitting it again", async () => {
    const { emitter, report, logged } = setUp();
    let calls = 0;
    const error = new Error("error listener failed");
    emitter.on("error", () => {
      calls += 1;
      throw error;
    });

    report(reportOf());
    await emitter.settle();

    assert.equal(calls, 1);
    assert.deepEqual(logged, [
      {
        message: "unhandled listener error",
        context: { error, event: "error" },
      },
    ]);
  });
});
