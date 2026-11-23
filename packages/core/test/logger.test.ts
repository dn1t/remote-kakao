import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { defaultLogger, resolveLogger, silentLogger } from "../src/logger.ts";
import type { Logger } from "../src/types.ts";

/** Replaces the methods of `console` with mocks that print nothing. */
function spyOnConsole() {
  return {
    log: mock.method(console, "log", () => {}),
    debug: mock.method(console, "debug", () => {}),
    info: mock.method(console, "info", () => {}),
    warn: mock.method(console, "warn", () => {}),
    error: mock.method(console, "error", () => {}),
  };
}

afterEach(() => mock.restoreAll());

describe("defaultLogger", () => {
  it("prints warnings and errors with a prefix", () => {
    const spy = spyOnConsole();

    defaultLogger.warn("careful");
    defaultLogger.error("broken");

    assert.deepEqual(
      spy.warn.mock.calls.map((call) => call.arguments),
      [["[remote-kakao] careful"]],
    );
    assert.deepEqual(
      spy.error.mock.calls.map((call) => call.arguments),
      [["[remote-kakao] broken"]],
    );
  });

  it("prints the context after the message", () => {
    const spy = spyOnConsole();
    const context = { device: "phone" };

    defaultLogger.warn("careful", context);
    defaultLogger.error("broken", context);

    assert.deepEqual(spy.warn.mock.calls[0]?.arguments, ["[remote-kakao] careful", context]);
    assert.deepEqual(spy.error.mock.calls[0]?.arguments, ["[remote-kakao] broken", context]);
  });

  it("drops debug and info", () => {
    const spy = spyOnConsole();

    defaultLogger.debug("detail", { a: 1 });
    defaultLogger.info("news");

    for (const method of Object.values(spy)) assert.equal(method.mock.callCount(), 0);
  });
});

describe("silentLogger", () => {
  it("prints nothing", () => {
    const spy = spyOnConsole();

    silentLogger.debug("a");
    silentLogger.info("b");
    silentLogger.warn("c", {});
    silentLogger.error("d", {});

    for (const method of Object.values(spy)) assert.equal(method.mock.callCount(), 0);
  });
});

describe("resolveLogger", () => {
  it("uses the default logger when the option is omitted", () => {
    assert.equal(resolveLogger(), defaultLogger);
    assert.equal(resolveLogger(undefined), defaultLogger);
  });

  it("uses a silent logger for false", () => {
    assert.equal(resolveLogger(false), silentLogger);
  });

  it("uses the given logger as it is", () => {
    const custom: Logger = { debug() {}, info() {}, warn() {}, error() {} };

    assert.equal(resolveLogger(custom), custom);
  });
});
