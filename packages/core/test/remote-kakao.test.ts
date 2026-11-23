import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { isRKError } from "../src/errors.ts";
import { RemoteKakao } from "../src/remote-kakao.ts";
import type { Transport } from "../src/types.ts";

const transport: Transport = {
  name: "fake",
  async listen() {
    throw new Error("not used yet");
  },
};

function create() {
  return new RemoteKakao({ transports: [transport], auth: false, logger: false });
}

afterEach(() => mock.timers.reset());

describe("RemoteKakao", () => {
  describe("constructor", () => {
    it("throws for options that are not valid", () => {
      assert.throws(() => new RemoteKakao({ transports: [], auth: false }), TypeError);
      assert.throws(
        () => new RemoteKakao({ transports: [transport], auth: false, requestTimeout: -1 }),
        RangeError,
      );
    });

    it("does not need anything else to be created", () => {
      assert.doesNotThrow(create);
    });
  });

  describe("devices", () => {
    it("has no devices before one connects", () => {
      assert.equal(create().devices.size, 0);
    });
  });

  describe("listeners", () => {
    it("on and once return a function that removes the listener, which also works with using", () => {
      const kakao = create();

      for (const off of [kakao.on("message", () => {}), kakao.once("message", () => {})]) {
        assert.equal(typeof off, "function");
        assert.equal(typeof off[Symbol.dispose], "function");
        assert.doesNotThrow(off);
      }
    });

    it("takes a signal to remove the listener", () => {
      const kakao = create();
      const controller = new AbortController();

      kakao.on("message", () => {}, { signal: controller.signal });

      assert.doesNotThrow(() => controller.abort());
    });
  });

  describe("wait", () => {
    it("rejects with TIMEOUT when the event does not happen in time", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const waiting = assert.rejects(create().wait("message", { timeout: 100 }), (error) =>
        isRKError(error, "TIMEOUT"),
      );

      mock.timers.tick(100);

      await waiting;
    });

    it("rejects with ABORTED when the signal is aborted", async () => {
      const controller = new AbortController();
      const waiting = assert.rejects(
        create().wait("deviceConnect", { signal: controller.signal }),
        (error) => isRKError(error, "ABORTED"),
      );

      controller.abort();

      await waiting;
    });
  });

  describe("iterate", () => {
    it("ends the loop when the signal is aborted", async () => {
      const controller = new AbortController();
      const messages = create().iterate("message", { signal: controller.signal });
      const seen: unknown[] = [];

      const loop = (async () => {
        for await (const message of messages) seen.push(message);
      })();
      controller.abort();
      await loop;

      assert.deepEqual(seen, []);
    });
  });
});
