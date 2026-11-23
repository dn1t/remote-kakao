import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultLogger, silentLogger } from "../src/logger.ts";
import { resolveOptions } from "../src/options.ts";
import type { RemoteKakaoOptions, Transport } from "../src/types.ts";

const transport: Transport = {
  name: "udp",
  async listen() {
    throw new Error("unused");
  },
};
const base: RemoteKakaoOptions = { transports: [transport], auth: false };

/** `RemoteKakaoOptions` with fields set to something they should not be, as plain JS can. */
const invalid = (fields: Record<string, unknown>) =>
  ({ ...base, ...fields }) as unknown as RemoteKakaoOptions;

describe("resolveOptions", () => {
  describe("defaults", () => {
    it("fills in the timeouts and the logger", () => {
      const resolved = resolveOptions(base);

      assert.equal(resolved.requestTimeout, 30_000);
      assert.deepEqual(resolved.heartbeat, { interval: 10_000, timeout: 30_000 });
      assert.equal(resolved.logger, defaultLogger);
      assert.equal(resolved.auth, false);
      assert.deepEqual(resolved.transports, [transport]);
    });

    it("takes a heartbeat timeout of three intervals when only the interval is set", () => {
      assert.deepEqual(resolveOptions({ ...base, heartbeat: { interval: 60_000 } }).heartbeat, {
        interval: 60_000,
        timeout: 180_000,
      });
    });

    it("keeps what is given", () => {
      const logger = { debug() {}, info() {}, warn() {}, error() {} };

      const resolved = resolveOptions({
        ...base,
        requestTimeout: 5000,
        heartbeat: { interval: 1000, timeout: 2500 },
        logger,
      });

      assert.equal(resolved.requestTimeout, 5000);
      assert.deepEqual(resolved.heartbeat, { interval: 1000, timeout: 2500 });
      assert.equal(resolved.logger, logger);
    });

    it("silences the logger for logger: false", () => {
      assert.equal(resolveOptions({ ...base, logger: false }).logger, silentLogger);
    });

    it("copies the list of transports", () => {
      const transports = [transport];

      const resolved = resolveOptions({ ...base, transports });
      transports.push(transport);

      assert.equal(resolved.transports.length, 1);
    });
  });

  describe("auth", () => {
    it("accepts a token as a string or a function, with or without verify", () => {
      for (const auth of [
        { token: "secret" },
        { token: () => "secret" },
        { token: async () => undefined },
        { token: "secret", verify: () => true },
      ]) {
        assert.equal(resolveOptions({ ...base, auth }).auth, auth);
      }
    });

    it("is required, so that turning it off has to be said", () => {
      assert.throws(() => resolveOptions({ transports: [transport] } as never), {
        name: "TypeError",
        message: /`auth` is required/,
      });
    });

    for (const [title, auth] of [
      ["a string", "secret"],
      ["null", null],
      ["true", true],
      ["no token", {}],
      ["an empty token", { token: "" }],
      ["a token that is a number", { token: 1 }],
      ["a verify that is not a function", { token: "x", verify: true }],
    ] as const) {
      it(`refuses ${title}`, () => {
        assert.throws(() => resolveOptions(invalid({ auth })), TypeError);
      });
    }
  });

  describe("transports", () => {
    for (const [title, transports] of [
      ["none", undefined],
      ["an empty list", []],
      ["something that is not a list", transport],
      ["an item that is not an object", [null]],
      ["a transport without a name", [{ listen() {} }]],
      ["a transport without listen", [{ name: "udp" }]],
    ] as const) {
      it(`refuses ${title}`, () => {
        assert.throws(() => resolveOptions(invalid({ transports })), TypeError);
      });
    }
  });

  describe("options", () => {
    for (const options of [undefined, null, "options"]) {
      it(`refuses ${String(options)}`, () => {
        assert.throws(() => resolveOptions(options as never), {
          name: "TypeError",
          message: "options are required",
        });
      });
    }
  });

  describe("numbers", () => {
    const bad = [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "5000"];

    for (const value of bad) {
      it(`refuses the requestTimeout ${String(value)}`, () => {
        assert.throws(() => resolveOptions(invalid({ requestTimeout: value })), {
          name: "RangeError",
          message: /requestTimeout/,
        });
      });
    }

    it("accepts the longest requestTimeout setTimeout takes", () => {
      assert.equal(
        resolveOptions({ ...base, requestTimeout: 2 ** 31 - 1 }).requestTimeout,
        2 ** 31 - 1,
      );
    });

    for (const value of [...bad, 0]) {
      for (const field of ["interval", "timeout"]) {
        it(`refuses the heartbeat ${field} ${String(value)}`, () => {
          assert.throws(
            () =>
              resolveOptions(invalid({ heartbeat: { interval: 1, timeout: 2, [field]: value } })),
            { name: "RangeError", message: new RegExp(`heartbeat.${field}`) },
          );
        });
      }
    }

    it("refuses a heartbeat timeout that is not longer than the interval", () => {
      for (const heartbeat of [
        { interval: 1000, timeout: 1000 },
        { interval: 1000, timeout: 500 },
      ]) {
        assert.throws(() => resolveOptions({ ...base, heartbeat }), {
          name: "RangeError",
          message: /longer/,
        });
      }
    });
  });
});
