import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type { SessionKeys } from "../src/device.ts";
import { SessionState } from "../src/device.ts";
import { isRKError } from "../src/errors.ts";
import type { AnyFrame } from "../src/protocol.ts";
import { deriveKey, Direction, openFrame } from "../src/seal.ts";
import type { Link } from "../src/types.ts";

const SALT = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const KEYS: SessionKeys = {
  salt: SALT,
  up: deriveKey("token", SALT, Direction.Up),
  down: deriveKey("token", SALT, Direction.Down),
};

/** Link that records what is written to it. `failNext` makes the next writes reject. */
function fakeLink(): Link & { written: Uint8Array[]; failNext: Error[] } {
  const written: Uint8Array[] = [];
  const failNext: Error[] = [];
  return {
    remoteAddress: "10.0.0.2:5000",
    reliable: true,
    frames: (async function* () {})(),
    written,
    failNext,
    async send(frame) {
      const error = failNext.shift();
      if (error) throw error;
      written.push(frame);
    },
    close() {},
  };
}

function newSession(
  options: { keys?: SessionKeys | undefined; budget?: number; link?: Link } = {},
): SessionState {
  return new SessionState({
    id: "s1",
    device: "phone",
    transport: "udp",
    link: options.link ?? fakeLink(),
    keys: "keys" in options ? options.keys : KEYS,
    budget: options.budget,
  });
}

const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

afterEach(() => mock.timers.reset());

describe("SessionState", () => {
  it("exposes the public session info", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });

    const session = newSession({ budget: 5000 });

    assert.equal(session.transport, "udp");
    assert.equal(session.remoteAddress, "10.0.0.2:5000");
    assert.equal(session.startedAt.getTime(), 1_000_000);
    assert.equal(session.expiresAt?.getTime(), 1_005_000);
  });

  it("has no expiry without a budget", () => {
    assert.equal(newSession().expiresAt, undefined);
  });

  describe("send", () => {
    it("seals frames for the device with counters 0, 1, 2", async () => {
      const link = fakeLink();
      const session = newSession({ link });

      await session.send({ t: "idle" });
      await session.send({ t: "ack", ids: ["a"] });
      await session.send({ t: "bye", reason: "done" });

      const opened = link.written.map((bytes) => openFrame(bytes, KEYS.down));
      assert.deepEqual(
        opened.map((frame) => frame?.counter),
        [0n, 1n, 2n],
      );
      assert.deepEqual(
        opened.map((frame) => frame?.frame),
        [{ t: "idle" }, { t: "ack", ids: ["a"] }, { t: "bye", reason: "done" }],
      );
      for (const frame of opened) {
        assert.equal(frame?.direction, Direction.Down);
        assert.equal(frame?.device, "phone");
        assert.deepEqual(Buffer.from(frame!.salt), SALT);
      }
    });

    it("does not reuse a counter for frames sent without waiting", async () => {
      const link = fakeLink();
      const session = newSession({ link });

      await Promise.all([session.send({ t: "idle" }), session.send({ t: "idle" })]);

      const counters = link.written.map((bytes) => openFrame(bytes, KEYS.down)?.counter);
      assert.deepEqual(counters, [0n, 1n]);
    });

    it("does not reuse the counter of a frame the link failed to write", async () => {
      const link = fakeLink();
      const session = newSession({ link });
      link.failNext.push(new Error("closed"));

      await assert.rejects(session.send({ t: "idle" }), { message: "closed" });
      await session.send({ t: "idle" });

      assert.equal(openFrame(link.written[0]!, KEYS.down)?.counter, 1n);
    });

    it("sends plain frames when there are no keys", async () => {
      const link = fakeLink();
      const session = newSession({ keys: undefined, link });

      await session.send({ t: "idle" });

      const opened = openFrame(link.written[0]!);
      assert.deepEqual(opened?.frame, { t: "idle" } satisfies AnyFrame);
      assert.equal(opened?.sealed, false);
      assert.equal(opened?.direction, Direction.Down);
      assert.equal(opened?.device, "phone");
    });

    it("rejects, instead of throwing, when the frame can't be sealed", async () => {
      const session = newSession({ keys: { ...KEYS, salt: new Uint8Array(3) } });

      await assert.rejects(session.send({ t: "idle" }), RangeError);
    });
  });

  describe("acceptCounter", () => {
    it("refuses a counter it has already accepted", () => {
      const session = newSession();

      assert.deepEqual(
        [0n, 1n, 1n, 0n, 2n].map((counter) => session.acceptCounter(counter)),
        [true, true, false, false, true],
      );
    });
  });

  describe("ping", () => {
    it("sends a ping and resolves when the pong arrives", async () => {
      const before = timers();
      const link = fakeLink();
      const session = newSession({ link });

      const ping = session.ping(1000);
      session.resolvePing();

      await ping;
      assert.deepEqual(openFrame(link.written[0]!, KEYS.down)?.frame, { t: "ping" });
      assert.equal(timers(), before);
    });

    it("resolves pings in the order they were sent", async () => {
      const session = newSession();
      const order: number[] = [];

      const first = session.ping(1000).then(() => order.push(1));
      const second = session.ping(1000).then(() => order.push(2));
      session.resolvePing();
      await first;
      assert.deepEqual(order, [1]);
      session.resolvePing();
      await second;

      assert.deepEqual(order, [1, 2]);
    });

    it("ignores a pong nobody waits for", () => {
      assert.doesNotThrow(() => newSession().resolvePing());
    });

    it("rejects with TIMEOUT when no pong arrives", async () => {
      const before = timers();
      mock.timers.enable({ apis: ["setTimeout"] });
      const session = newSession();

      const ping = assert.rejects(session.ping(100), (error) => isRKError(error, "TIMEOUT"));
      mock.timers.tick(100);

      await ping;
      assert.equal(timers(), before);
    });

    it("does not let a pong answer a ping that timed out", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const session = newSession();
      const late = session.ping(100).catch(() => "timeout");
      mock.timers.tick(100);
      assert.equal(await late, "timeout");

      let resolved = false;
      const next = session.ping(1000).then(() => (resolved = true));
      session.resolvePing();
      await next;

      assert.equal(resolved, true);
      session.resolvePing();
    });

    it("rejects with the error of the link, and stops waiting, when the frame can't be sent", async () => {
      const before = timers();
      const link = fakeLink();
      const session = newSession({ link });
      link.failNext.push(new Error("closed"));

      await assert.rejects(session.ping(1000), { message: "closed" });

      assert.equal(timers(), before);
    });

    it("does not let a pong answer a ping that failed to send", async () => {
      const link = fakeLink();
      const session = newSession({ link });
      link.failNext.push(new Error("closed"));
      await assert.rejects(session.ping(1000));

      let resolved = false;
      const next = session.ping(1000).then(() => (resolved = true));
      session.resolvePing();
      await next;

      assert.equal(resolved, true);
    });

    it("rejects with DEVICE_OFFLINE when the session ends first", async () => {
      const before = timers();
      const session = newSession();

      const ping = assert.rejects(session.ping(1000), (error) =>
        isRKError(error, "DEVICE_OFFLINE"),
      );
      session.end();

      await ping;
      assert.equal(timers(), before);
    });

    it("rejects with DEVICE_OFFLINE on an ended session without sending", async () => {
      const link = fakeLink();
      const session = newSession({ link });
      session.end();

      await assert.rejects(session.ping(1000), (error) => isRKError(error, "DEVICE_OFFLINE"));

      assert.deepEqual(link.written, []);
    });
  });

  describe("end", () => {
    it("marks the session as ended, and can be called again", () => {
      const session = newSession();
      assert.equal(session.ended, false);

      session.end();
      session.end();

      assert.equal(session.ended, true);
    });
  });
});
