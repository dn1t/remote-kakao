import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { HelloContext } from "../src/hello.ts";
import { checkHello, MAX_CLOCK_SKEW, SALT_TTL, toDeviceHello } from "../src/hello.ts";
import type { Hello } from "../src/protocol.ts";
import { SaltCache } from "../src/salt-cache.ts";
import type { DeviceHello } from "../src/types.ts";

const NOW = 1_000_000_000_000;

const hello = (overrides: Record<string, unknown> = {}): Hello =>
  ({
    t: "hello",
    v: 1,
    ts: NOW,
    device: { id: "phone", name: "Phone", platform: "ios" },
    client: { name: "test", version: "1" },
    caps: ["room.send"],
    appInstances: [{ id: "kakao", me: { id: "u1", name: "Ann" } }, { id: "work" }],
    ...overrides,
  }) as Hello;

function context(overrides: Partial<HelloContext> = {}) {
  const verifyErrors: unknown[] = [];
  const full: HelloContext = {
    device: "phone",
    salt: Uint8Array.of(1, 2, 3),
    transport: "udp",
    remoteAddress: "10.0.0.2:5000",
    saltCache: new SaltCache(SALT_TTL),
    verify: undefined,
    onVerifyError: (error) => verifyErrors.push(error),
    ...overrides,
  };
  return { context: full, verifyErrors };
}

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: NOW }));
afterEach(() => mock.timers.reset());

describe("constants", () => {
  it("remembers a salt for longer than a recorded hello keeps passing the clock check", () => {
    assert.ok(SALT_TTL > 2 * MAX_CLOCK_SKEW);
  });
});

describe("checkHello", () => {
  it("accepts a good hello", async () => {
    assert.deepEqual(await checkHello(hello(), context().context), { accepted: true });
  });

  describe("version", () => {
    it("rejects another protocol version with PROTOCOL_MISMATCH, naming ours", async () => {
      const verdict = await checkHello(hello({ v: 2 }), context().context);

      assert.deepEqual(verdict, {
        accepted: false,
        code: "PROTOCOL_MISMATCH",
        reason: "version mismatch",
        reject: { t: "reject", code: "PROTOCOL_MISMATCH", message: "server speaks v1" },
      });
    });

    it("checks the version before anything else, as another version may have another shape", async () => {
      const { context: ctx } = context();

      const verdict = await checkHello({ t: "hello", v: 7 } as unknown as Hello, ctx);

      assert.equal(verdict.accepted === false && verdict.code, "PROTOCOL_MISMATCH");
      assert.equal(ctx.saltCache.size, 0);
    });
  });

  describe("shape", () => {
    const broken: Array<[string, Record<string, unknown>]> = [
      ["no ts", { ts: undefined }],
      ["a ts that is not a number", { ts: "now" }],
      ["a ts that is not finite", { ts: Number.NaN }],
      ["no device", { device: undefined }],
      ["a device without a name", { device: { id: "phone", platform: "ios" } }],
      ["a device id that is not a string", { device: { id: 1, name: "P", platform: "ios" } }],
      ["no client", { client: null }],
      ["a client without a version", { client: { name: "test" } }],
      ["caps that are not a list", { caps: "room.send" }],
      ["a cap that is not a string", { caps: ["room.send", 1] }],
      ["appInstances that are not a list", { appInstances: {} }],
      ["an app instance without an id", { appInstances: [{}] }],
      ["an app instance whose me has no name", { appInstances: [{ id: "k", me: { id: "u" } }] }],
      ["a budget that is not a number", { budget: "5s" }],
      ["a budget of 0", { budget: 0 }],
      ["a negative budget", { budget: -1 }],
      ["a budget past what a timer can wait", { budget: 2 ** 31 }],
    ];
    for (const [title, overrides] of broken) {
      it(`closes the link for a hello with ${title}, telling the device nothing`, async () => {
        const verdict = await checkHello(hello(overrides), context().context);

        assert.equal(verdict.accepted, false);
        assert.ok(!verdict.accepted);
        assert.equal(verdict.code, "PROTOCOL_ERROR");
        assert.equal(verdict.reject, undefined);
        assert.match(verdict.reason, /^hello has no valid/);
      });
    }

    it("accepts a hello with no caps and no app instances, and with a budget", async () => {
      const verdict = await checkHello(
        hello({ caps: [], appInstances: [], budget: 5000 }),
        context().context,
      );

      assert.deepEqual(verdict, { accepted: true });
    });

    it("accepts the longest budget a timer can wait", async () => {
      const verdict = await checkHello(hello({ budget: 2 ** 31 - 1 }), context().context);

      assert.deepEqual(verdict, { accepted: true });
    });
  });

  describe("device", () => {
    it("rejects a hello that names another device than the frame that held it", async () => {
      const verdict = await checkHello(hello(), context({ device: "tablet" }).context);

      assert.deepEqual(verdict, {
        accepted: false,
        code: "AUTH_FAILED",
        reason: "hello is from another device than the frame",
        reject: { t: "reject", code: "AUTH_FAILED", message: "device id does not match the frame" },
      });
    });

    it("does not remember the salt of such a hello", async () => {
      const { context: ctx } = context({ device: "tablet" });

      await checkHello(hello(), ctx);

      assert.equal(ctx.saltCache.size, 0);
    });
  });

  describe("clock", () => {
    it("accepts a clock off by up to the limit, in either direction", async () => {
      for (const ts of [NOW - MAX_CLOCK_SKEW, NOW + MAX_CLOCK_SKEW, NOW + 1]) {
        const verdict = await checkHello(hello({ ts }), context().context);

        assert.deepEqual(verdict, { accepted: true }, String(ts));
      }
    });

    it("rejects a clock off by more, and tells the device", async () => {
      for (const ts of [NOW - MAX_CLOCK_SKEW - 1, NOW + MAX_CLOCK_SKEW + 1]) {
        const verdict = await checkHello(hello({ ts }), context().context);

        assert.deepEqual(verdict, {
          accepted: false,
          code: "AUTH_FAILED",
          reason: "hello timestamp out of range",
          reject: {
            t: "reject",
            code: "AUTH_FAILED",
            message: "clock differs from the server by more than 2 minutes",
          },
        });
      }
    });

    it("does not remember the salt of a hello with a bad clock", async () => {
      const { context: ctx } = context();

      await checkHello(hello({ ts: 0 }), ctx);

      assert.equal(ctx.saltCache.size, 0);
    });
  });

  describe("salt", () => {
    it("refuses the same salt a second time, telling the device nothing", async () => {
      const { context: ctx } = context();

      const first = await checkHello(hello(), ctx);
      const second = await checkHello(hello(), ctx);

      assert.deepEqual(first, { accepted: true });
      assert.deepEqual(second, {
        accepted: false,
        code: "AUTH_FAILED",
        reason: "replayed session salt",
        reject: undefined,
      });
    });

    it("accepts the same salt again once it is forgotten", async () => {
      const { context: ctx } = context();
      await checkHello(hello(), ctx);

      mock.timers.tick(SALT_TTL);

      assert.deepEqual(await checkHello(hello({ ts: NOW + SALT_TTL }), ctx), { accepted: true });
    });

    it("has no salt to check for a plain hello", async () => {
      const { context: ctx } = context({ salt: new Uint8Array(0) });

      for (const _ of [1, 2]) {
        assert.deepEqual(await checkHello(hello(), ctx), { accepted: true });
      }
      assert.equal(ctx.saltCache.size, 0);
    });
  });

  describe("verify", () => {
    it("accepts a hello that verify allows, giving it the public view of the hello", async () => {
      const seen: DeviceHello[] = [];
      const { context: ctx } = context({
        verify: (view) => {
          seen.push(view);
          return true;
        },
      });

      const verdict = await checkHello(hello({ budget: 5000 }), ctx);

      assert.deepEqual(verdict, { accepted: true });
      assert.deepEqual(seen, [
        {
          device: { id: "phone", name: "Phone", platform: "ios" },
          client: { name: "test", version: "1" },
          protocolVersion: 1,
          capabilities: ["room.send"],
          appInstances: [{ id: "kakao", me: { id: "u1", name: "Ann" } }, { id: "work" }],
          budget: 5000,
          transport: "udp",
          remoteAddress: "10.0.0.2:5000",
        },
      ]);
    });

    it("waits for a verify that is async", async () => {
      const { context: ctx } = context({ verify: async () => true });

      assert.deepEqual(await checkHello(hello(), ctx), { accepted: true });
    });

    it("rejects with AUTH_FAILED when verify says no", async () => {
      for (const verify of [() => false, async () => false]) {
        const verdict = await checkHello(hello(), context({ verify }).context);

        assert.deepEqual(verdict, {
          accepted: false,
          code: "AUTH_FAILED",
          reason: "verify rejected the device",
          reject: { t: "reject", code: "AUTH_FAILED", message: "rejected by verify" },
        });
      }
    });

    it("rejects, and tells onVerifyError, when verify throws or rejects", async () => {
      const failure = new Error("database down");
      for (const verify of [
        () => {
          throw failure;
        },
        async () => {
          throw failure;
        },
      ]) {
        const { context: ctx, verifyErrors } = context({ verify });

        const verdict = await checkHello(hello(), ctx);

        assert.equal(verdict.accepted, false);
        assert.deepEqual(verifyErrors, [failure]);
      }
    });

    it("is not asked about a hello that failed an earlier check", async () => {
      let asked = 0;
      const verify = () => {
        asked += 1;
        return true;
      };

      await checkHello(hello({ v: 2 }), context({ verify }).context);
      await checkHello(hello({ ts: 0 }), context({ verify }).context);
      await checkHello(hello({ caps: 1 }), context({ verify }).context);

      assert.equal(asked, 0);
    });
  });
});

describe("toDeviceHello", () => {
  it("copies the fields of the hello that devices of the public API see", () => {
    const view = toDeviceHello(hello(), { transport: "sse", remoteAddress: "1.2.3.4" });

    assert.deepEqual(view, {
      device: { id: "phone", name: "Phone", platform: "ios" },
      client: { name: "test", version: "1" },
      protocolVersion: 1,
      capabilities: ["room.send"],
      appInstances: [{ id: "kakao", me: { id: "u1", name: "Ann" } }, { id: "work" }],
      budget: undefined,
      transport: "sse",
      remoteAddress: "1.2.3.4",
    });
  });

  it("does not pass on fields of an app instance that it does not know", () => {
    const view = toDeviceHello(
      hello({ appInstances: [{ id: "k", me: { id: "u", name: "A", secret: 1 }, extra: 1 }] }),
      { transport: "udp", remoteAddress: "x" },
    );

    assert.deepEqual(view.appInstances, [{ id: "k", me: { id: "u", name: "A" } }]);
  });
});
