import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionKeys } from "../src/device.ts";
import { SessionState } from "../src/device.ts";
import type { TokenLookup } from "../src/intake.ts";
import { intake } from "../src/intake.ts";
import type { AnyFrame, Hello } from "../src/protocol.ts";
import { deriveKey, Direction, sealFrame } from "../src/seal.ts";
import { fakeLink } from "./fakes.ts";

const SALT = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const OTHER_SALT = Buffer.from("ff0102030405060708090a0b0c0d0e0f", "hex");
const KEYS: SessionKeys = {
  salt: SALT,
  up: deriveKey("token", SALT, Direction.Up),
  down: deriveKey("token", SALT, Direction.Down),
};

const HELLO: Hello = {
  t: "hello",
  v: 1,
  ts: 1000,
  device: { id: "phone", name: "Phone", platform: "ios" },
  client: { name: "test", version: "1" },
  caps: [],
  appInstances: [],
};

/** Token lookup that knows one token, and records the ids it was asked about. */
function lookup(...args: [] | [token: string | undefined]) {
  const token = args.length === 0 ? "token" : args[0];
  const asked: string[] = [];
  const tokenOf: TokenLookup = async (device) => {
    asked.push(device);
    return token;
  };
  return { tokenOf, asked };
}

/** A sealed frame from the device, as the client would send it. */
function sealed(
  frame: AnyFrame,
  counter: bigint,
  options: { key?: Uint8Array; salt?: Uint8Array; device?: string } = {},
) {
  return sealFrame(frame, {
    direction: Direction.Up,
    device: options.device ?? "phone",
    salt: options.salt ?? SALT,
    counter,
    key: options.key ?? KEYS.up,
  });
}

const plain = (frame: AnyFrame, device = "phone") =>
  sealFrame(frame, { direction: Direction.Up, device });

function sessionOf(keys: SessionKeys | undefined) {
  return new SessionState({
    id: "s1",
    device: "phone",
    transport: "udp",
    link: fakeLink(),
    keys,
    budget: undefined,
  });
}

describe("intake", () => {
  describe("before the link has a session", () => {
    it("opens a sealed hello, with the keys made from the token of the device", async () => {
      const { tokenOf, asked } = lookup();

      const result = await intake(sealed(HELLO, 0n), tokenOf, undefined);

      assert.ok(result.kind === "frame");
      assert.deepEqual(result.incoming.frame, HELLO);
      assert.equal(result.incoming.device, "phone");
      assert.equal(result.incoming.counter, 0n);
      assert.deepEqual(Buffer.from(result.keys!.salt), SALT);
      assert.deepEqual(result.keys?.up, KEYS.up);
      assert.deepEqual(result.keys?.down, KEYS.down);
      assert.deepEqual(asked, ["phone"]);
    });

    it("gives keys that do not change when the bytes are reused", async () => {
      const raw = Uint8Array.from(sealed(HELLO, 0n));
      const { tokenOf } = lookup();

      const result = await intake(raw, tokenOf, undefined);
      raw.fill(0);

      assert.ok(result.kind === "frame");
      assert.deepEqual(Buffer.from(result.keys!.salt), SALT);
    });

    it("opens a plain hello, with no keys, when there is no auth", async () => {
      const result = await intake(plain(HELLO), undefined, undefined);

      assert.ok(result.kind === "frame");
      assert.deepEqual(result.incoming.frame, HELLO);
      assert.equal(result.keys, undefined);
    });

    it("lets the caller see a frame that is not a hello", async () => {
      const result = await intake(sealed({ t: "ping" }, 0n), lookup().tokenOf, undefined);

      assert.ok(result.kind === "frame");
      assert.deepEqual(result.incoming.frame, { t: "ping" });
    });

    it("closes the link for bytes that are not a frame", async () => {
      for (const raw of [new Uint8Array(0), Uint8Array.of(9, 9, 9), Buffer.from("hello")]) {
        const result = await intake(raw, lookup().tokenOf, undefined);

        assert.deepEqual(result, {
          kind: "close",
          code: "PROTOCOL_ERROR",
          reason: "malformed frame",
        });
      }
    });

    it("closes the link for a frame going to the device", async () => {
      const raw = sealFrame({ t: "ping" }, { direction: Direction.Down, device: "phone" });

      const result = await intake(raw, undefined, undefined);

      assert.deepEqual(result, {
        kind: "close",
        code: "PROTOCOL_ERROR",
        reason: "frame going the wrong way",
      });
    });

    it("closes the link for a plain frame when auth is on, with AUTH_FAILED", async () => {
      const result = await intake(plain(HELLO), lookup().tokenOf, undefined);

      assert.deepEqual(result, {
        kind: "close",
        code: "AUTH_FAILED",
        reason: "expected a sealed frame",
      });
    });

    it("closes the link for a sealed frame when auth is off", async () => {
      const result = await intake(sealed(HELLO, 0n), undefined, undefined);

      assert.deepEqual(result, {
        kind: "close",
        code: "PROTOCOL_ERROR",
        reason: "unexpected sealed frame",
      });
    });

    for (const token of [undefined, ""]) {
      it(`closes the link with AUTH_FAILED when the device has the token ${JSON.stringify(token)}`, async () => {
        const result = await intake(sealed(HELLO, 0n), lookup(token).tokenOf, undefined);

        assert.deepEqual(result, {
          kind: "close",
          code: "AUTH_FAILED",
          reason: "no token for the device",
        });
      });
    }

    it("passes on the error of a token lookup that fails", async () => {
      const tokenOf: TokenLookup = async () => {
        throw new Error("database down");
      };

      await assert.rejects(intake(sealed(HELLO, 0n), tokenOf, undefined), {
        message: "database down",
      });
    });

    it("ignores a frame sealed with another token, and one that was changed", async () => {
      const changed = Buffer.from(sealed(HELLO, 0n));
      changed[changed.length - 1]! ^= 1;

      for (const raw of [
        sealed(HELLO, 0n, { key: deriveKey("other", SALT, Direction.Up) }),
        changed,
      ]) {
        const result = await intake(raw, lookup().tokenOf, undefined);

        assert.deepEqual(result, { kind: "ignore", reason: "frame did not open" });
      }
    });

    it("ignores a frame that only a server sends", async () => {
      const raw = sealed({ t: "welcome", v: 1, session: "s" }, 0n);

      const result = await intake(raw, lookup().tokenOf, undefined);

      assert.deepEqual(result, { kind: "ignore", reason: "unexpected welcome frame" });
    });
  });

  describe("on a link with a session", () => {
    it("opens frames with the keys of the session, without asking for the token", async () => {
      const { tokenOf, asked } = lookup();
      const session = sessionOf(KEYS);

      const result = await intake(sealed({ t: "ping" }, 1n), tokenOf, session);

      assert.ok(result.kind === "frame");
      assert.deepEqual(result.incoming.frame, { t: "ping" });
      assert.equal(result.keys, KEYS);
      assert.deepEqual(asked, []);
    });

    it("takes frames that arrive out of order, and ignores one that arrives twice", async () => {
      const { tokenOf } = lookup();
      const session = sessionOf(KEYS);

      const results = [];
      for (const counter of [1n, 3n, 2n, 3n, 1n]) {
        results.push((await intake(sealed({ t: "ping" }, counter), tokenOf, session)).kind);
      }

      assert.deepEqual(results, ["frame", "frame", "frame", "ignore", "ignore"]);
    });

    it("says why a frame was ignored when its counter was used", async () => {
      const session = sessionOf(KEYS);
      await intake(sealed({ t: "ping" }, 5n), lookup().tokenOf, session);

      const result = await intake(sealed({ t: "ping" }, 5n), lookup().tokenOf, session);

      assert.deepEqual(result, {
        kind: "ignore",
        reason: "frame counter already used or too old",
      });
    });

    it("does not use up a counter for a frame that does not open", async () => {
      const { tokenOf } = lookup();
      const session = sessionOf(KEYS);
      const forged = sealed({ t: "ping" }, 7n, { key: deriveKey("other", SALT, Direction.Up) });

      await intake(forged, tokenOf, session);
      const result = await intake(sealed({ t: "ping" }, 7n), tokenOf, session);

      assert.equal(result.kind, "frame");
    });

    it("ignores, instead of closing, what would have closed a link without a session", async () => {
      const { tokenOf } = lookup();
      const session = sessionOf(KEYS);
      const wrongWay = sealFrame({ t: "ping" }, { direction: Direction.Down, device: "phone" });

      for (const raw of [Buffer.from("junk"), plain({ t: "ping" }), wrongWay]) {
        assert.equal((await intake(raw, tokenOf, session)).kind, "ignore");
      }
      assert.equal((await intake(sealed({ t: "ping" }, 1n), undefined, session)).kind, "ignore");
    });

    it("ignores a frame of another device or another session", async () => {
      const { tokenOf } = lookup();
      const session = sessionOf(KEYS);
      const otherSalt = {
        salt: OTHER_SALT,
        key: deriveKey("token", OTHER_SALT, Direction.Up),
      };

      assert.deepEqual(
        await intake(sealed({ t: "ping" }, 1n, { device: "tablet" }), tokenOf, session),
        { kind: "ignore", reason: "frame of another device" },
      );
      assert.deepEqual(await intake(sealed({ t: "ping" }, 1n, otherSalt), tokenOf, session), {
        kind: "ignore",
        reason: "frame of another session",
      });
    });

    it("ignores a frame that only a server sends", async () => {
      const result = await intake(sealed({ t: "idle" }, 1n), lookup().tokenOf, sessionOf(KEYS));

      assert.deepEqual(result, { kind: "ignore", reason: "unexpected idle frame" });
    });

    it("opens plain frames as often as they come when there is no auth", async () => {
      const session = sessionOf(undefined);

      for (const _ of [1, 2]) {
        const result = await intake(plain({ t: "ping" }), undefined, session);

        assert.ok(result.kind === "frame");
        assert.equal(result.keys, undefined);
      }
    });

    it("ignores a plain frame of another device when there is no auth", async () => {
      const result = await intake(plain({ t: "ping" }, "tablet"), undefined, sessionOf(undefined));

      assert.deepEqual(result, { kind: "ignore", reason: "frame of another device" });
    });
  });

  it("accepts every frame a client sends", async () => {
    const frames: AnyFrame[] = [
      HELLO,
      { t: "event", id: "e1", name: "message", data: {} } as AnyFrame,
      { t: "req", id: "r1", method: "x:y", params: null, ttl: 1 },
      { t: "res", id: "r1", ok: true, result: null },
      { t: "ping" },
      { t: "pong" },
      { t: "bye" },
    ];

    for (const frame of frames) {
      const result = await intake(plain(frame), undefined, undefined);

      assert.ok(result.kind === "frame", frame.t);
      assert.deepEqual(result.incoming.frame, frame);
    }
  });
});
