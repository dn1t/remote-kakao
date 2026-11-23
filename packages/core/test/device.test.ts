import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, describe, it, mock } from "node:test";

import type { SessionKeys } from "../src/device.ts";
import { MAX_SEEN_EVENTS, SessionState } from "../src/device.ts";
import { isRKError, RKError } from "../src/errors.ts";
import type { AnyFrame } from "../src/protocol.ts";
import { deriveKey, Direction, openFrame } from "../src/seal.ts";
import type { AppInstance, Link } from "../src/types.ts";
import { fakeLink, newDevice, plainSession, settled } from "./fakes.ts";

const SALT = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const KEYS: SessionKeys = {
  salt: SALT,
  up: deriveKey("token", SALT, Direction.Up),
  down: deriveKey("token", SALT, Direction.Down),
};

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

describe("DeviceState", () => {
  afterEach(() => mock.timers.reset());

  describe("status and info", () => {
    it("is offline until a session is attached, and after it is detached", () => {
      const { device } = newDevice();
      const { session } = plainSession();
      assert.equal(device.status, "offline");
      assert.equal(device.lastSeenAt, undefined);

      device.attachSession(session);
      assert.equal(device.status, "online");
      assert.equal(device.session, session);
      assert.ok(device.lastSeenAt);

      device.detachSession(session);
      assert.equal(device.status, "offline");
      assert.equal(device.session, undefined);
    });

    it("tells what it supports and finds app instances by id", () => {
      const { device } = newDevice();
      assert.equal(device.described, false);
      device.capabilities.add("room.send");
      const appInstance = { id: "kakao" } as AppInstance;
      device.appInstances = [appInstance];

      assert.equal(device.supports("room.send"), true);
      assert.equal(device.supports("room.icon"), false);
      assert.equal(device.appInstance("kakao"), appInstance);
      assert.equal(device.appInstance("other"), undefined);
    });
  });

  describe("request", () => {
    it("writes the request to the open session and resolves with the result", async () => {
      const { device } = newDevice();
      const { session, sent } = plainSession();
      device.attachSession(session);

      const request = device.request("room.markRead", { appInstance: "a", room: "r" });
      await Promise.resolve();
      device.handleResponse({ t: "res", id: "r1", ok: true, result: { done: 1 } });

      assert.deepEqual(await request, { done: 1 });
      assert.deepEqual(sent(), [
        {
          t: "req",
          id: "r1",
          method: "room.markRead",
          params: { appInstance: "a", room: "r" },
          ttl: 30_000,
        },
      ]);
    });

    it("sends an extension method the same way", async () => {
      const { device } = newDevice();
      const { session, sent } = plainSession();
      device.attachSession(session);

      const request = device.extensionRequest("x:y", { a: 1 });
      device.handleResponse({ t: "res", id: "r1", ok: true, result: 7 });

      assert.equal(await request, 7);
      assert.equal(sent()[0]?.method, "x:y");
    });

    it("holds the request until a session is attached, with the time left as ttl", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const { session, sent } = plainSession();

      const request = device.extensionRequest("x:y", null, { timeout: 10_000 });
      assert.equal(device.pendingCount, 1);
      mock.timers.tick(4000);
      device.attachSession(session);
      assert.deepEqual(
        sent().map((frame) => [frame.id, frame.ttl]),
        [["r1", 6000]],
      );
      device.handleResponse({ t: "res", id: "r1", ok: true, result: "ok" });

      assert.equal(await request, "ok");
      assert.equal(device.pendingCount, 0);
    });

    it("answers a client error with its code and message", async () => {
      const { device } = newDevice();
      device.attachSession(plainSession().session);

      const request = device.extensionRequest("x:y", null);
      device.handleResponse({
        t: "res",
        id: "r1",
        ok: false,
        error: { code: "NOT_FOUND", message: "no such room" },
      });

      await assert.rejects(request, (error) => {
        assert.ok(isRKError(error, "NOT_FOUND"));
        assert.equal(error.message, "no such room");
        assert.equal(error.device, device);
        return true;
      });
    });

    it("reads an unknown error code as CLIENT_ERROR", async () => {
      const { device } = newDevice();
      device.attachSession(plainSession().session);

      const request = device.extensionRequest("x:y", null);
      device.handleResponse({
        t: "res",
        id: "r1",
        ok: false,
        error: { code: "WEIRD" as "NOT_FOUND", message: "boom" },
      });

      await assert.rejects(request, (error) => isRKError(error, "CLIENT_ERROR"));
    });

    it("ignores a response to an unknown or already answered request", async () => {
      const { device } = newDevice();
      device.attachSession(plainSession().session);

      const request = device.extensionRequest("x:y", null);
      device.handleResponse({ t: "res", id: "nope", ok: true, result: 1 });
      device.handleResponse({ t: "res", id: "r1", ok: true, result: 2 });
      device.handleResponse({ t: "res", id: "r1", ok: true, result: 3 });

      assert.equal(await request, 2);
    });

    it("reports a failed write instead of rejecting the request", async () => {
      const { device, errors } = newDevice();
      const { session, link } = plainSession();
      device.attachSession(session);
      link.failNext.push(new Error("closed"));

      const request = settled(device.extensionRequest("x:y", null));
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(
        errors.map((error) => (error as Error).message),
        ["closed"],
      );
      device.rejectAll(new RKError("CLOSED", "closed"));
      await request;
    });

    it("tells the context whenever a request is added or settled", async () => {
      const { device, pendingChanges } = newDevice();
      device.attachSession(plainSession().session);

      const request = device.extensionRequest("x:y", null);
      device.handleResponse({ t: "res", id: "r1", ok: true, result: 1 });
      await request;

      assert.equal(pendingChanges.at(-1), 0);
      assert.ok(pendingChanges.includes(1));
    });
  });

  describe("deadline", () => {
    it("rejects with TIMEOUT when a request that was sent goes unanswered", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      device.attachSession(plainSession().session);

      const request = settled(device.extensionRequest("x:y", null, { timeout: 500 }));
      mock.timers.tick(500);

      const { error } = (await request) as { error: unknown };
      assert.ok(isRKError(error, "TIMEOUT"));
      assert.equal(error.retryable, true);
      assert.equal(device.pendingCount, 0);
    });

    it("rejects with DEVICE_OFFLINE when it never found a session", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();

      const request = settled(device.extensionRequest("x:y", null, { timeout: 500 }));
      mock.timers.tick(500);

      const { error } = (await request) as { error: unknown };
      assert.ok(isRKError(error, "DEVICE_OFFLINE"));
      assert.equal(device.pendingCount, 0);
    });

    it("uses the requestTimeout of the context by default", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice({ requestTimeout: 200 });

      const request = settled(device.extensionRequest("x:y", null));
      mock.timers.tick(199);
      assert.equal(device.pendingCount, 1);
      mock.timers.tick(1);

      assert.ok(isRKError(((await request) as { error: unknown }).error, "DEVICE_OFFLINE"));
    });

    for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "5000" as never]) {
      it(`rejects with a RangeError for the timeout ${String(timeout)}`, async () => {
        const { device } = newDevice();

        await assert.rejects(device.extensionRequest("x:y", null, { timeout }), RangeError);

        assert.equal(device.pendingCount, 0);
      });
    }

    it("accepts the longest timeout setTimeout takes", async () => {
      const { device } = newDevice();
      const request = device.extensionRequest("x:y", null, { timeout: 2 ** 31 - 1 });
      device.rejectAll(new RKError("CLOSED", "closed"));

      await assert.rejects(request, (error) => isRKError(error, "CLOSED"));
    });

    it("leaves no timer running once a request is settled", async () => {
      const before = timers();
      const { device } = newDevice();
      device.attachSession(plainSession(false).session);

      const request = device.extensionRequest("x:y", null, { timeout: 60_000 });
      assert.ok(timers() > before);
      device.handleResponse({ t: "res", id: "r1", ok: true, result: 1 });
      await request;

      assert.equal(timers(), before);
    });
  });

  describe("abort", () => {
    it("rejects at once with ABORTED when the signal is already aborted", async () => {
      const { device } = newDevice();
      const controller = new AbortController();
      const reason = new Error("stop");
      controller.abort(reason);

      await assert.rejects(
        device.extensionRequest("x:y", null, { signal: controller.signal }),
        (error) => isRKError(error, "ABORTED") && error.cause === reason,
      );
      assert.equal(device.pendingCount, 0);
    });

    it("rejects with ABORTED when the signal aborts while waiting, and stops listening", async () => {
      const { device } = newDevice();
      device.attachSession(plainSession().session);
      const controller = new AbortController();

      const request = device.extensionRequest("x:y", null, { signal: controller.signal });
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      controller.abort();

      await assert.rejects(request, (error) => isRKError(error, "ABORTED"));
      assert.equal(device.pendingCount, 0);
    });

    it("stops listening to the signal once the request is answered", async () => {
      const { device } = newDevice();
      device.attachSession(plainSession().session);
      const controller = new AbortController();

      const request = device.extensionRequest("x:y", null, { signal: controller.signal });
      device.handleResponse({ t: "res", id: "r1", ok: true, result: 1 });
      await request;

      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
  });

  describe("retransmission", () => {
    it("writes the request again at 2, 6, 14 and 30 s on a link that loses frames, then stops", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const { session, sent } = plainSession(false);
      device.attachSession(session);

      const request = settled(device.extensionRequest("x:y", null, { timeout: 100_000 }));
      const counts: number[] = [];
      for (const at of [1999, 2000, 5999, 6000, 13_999, 14_000, 29_999, 30_000, 99_000]) {
        mock.timers.tick(at - Date.now());
        await Promise.resolve();
        counts.push(sent().length);
      }

      assert.deepEqual(counts, [1, 2, 2, 3, 3, 4, 4, 5, 5]);
      device.rejectAll(new RKError("CLOSED", "closed"));
      await request;
    });

    it("sends the time left as ttl each time", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const { session, sent } = plainSession(false);
      device.attachSession(session);

      const request = settled(device.extensionRequest("x:y", null, { timeout: 10_000 }));
      mock.timers.tick(2000);
      await Promise.resolve();

      assert.deepEqual(
        sent().map((frame) => frame.ttl),
        [10_000, 8000],
      );
      device.rejectAll(new RKError("CLOSED", "closed"));
      await request;
    });

    it("does not write again on a reliable link", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const { session, sent } = plainSession(true);
      device.attachSession(session);

      const request = settled(device.extensionRequest("x:y", null, { timeout: 100_000 }));
      mock.timers.tick(60_000);

      assert.equal(sent().length, 1);
      device.rejectAll(new RKError("CLOSED", "closed"));
      await request;
    });

    it("does not retry when the deadline comes before the next retry", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const { session, sent } = plainSession(false);
      device.attachSession(session);

      const request = settled(device.extensionRequest("x:y", null, { timeout: 1500 }));
      mock.timers.tick(1500);
      await request;

      assert.equal(sent().length, 1);
    });

    it("starts the retransmission over in the next session", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const first = plainSession(false);
      const second = plainSession(false);
      device.attachSession(first.session);

      const request = settled(device.extensionRequest("x:y", null, { timeout: 100_000 }));
      mock.timers.tick(2000);
      device.detachSession(first.session);
      device.attachSession(second.session);
      const counts: number[] = [];
      for (const after of [1999, 1, 3999, 1]) {
        mock.timers.tick(after);
        await Promise.resolve();
        counts.push(second.sent().length);
      }

      assert.deepEqual(counts, [1, 2, 2, 3]);
      device.rejectAll(new RKError("CLOSED", "closed"));
      await request;
    });

    it("leaves no retransmission timer running after a detach, or when none would fit", async () => {
      const before = timers();
      const { device } = newDevice();
      const { session } = plainSession(false);
      device.attachSession(session);

      const short = settled(device.extensionRequest("x:y", null, { timeout: 1500 }));
      assert.equal(timers(), before + 1);
      device.rejectAll(new RKError("CLOSED", "closed"));
      await short;
      const long = settled(device.extensionRequest("x:y", null, { timeout: 60_000 }));
      assert.equal(timers(), before + 2);
      device.detachSession(session);

      assert.equal(timers(), before + 1);
      device.rejectAll(new RKError("CLOSED", "closed"));
      await long;
      assert.equal(timers(), before);
    });

    it("stops writing once the request is answered", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const { session, sent } = plainSession(false);
      device.attachSession(session);

      const request = device.extensionRequest("x:y", null, { timeout: 100_000 });
      device.handleResponse({ t: "res", id: "r1", ok: true, result: 1 });
      await request;
      mock.timers.tick(60_000);

      assert.equal(sent().length, 1);
    });
  });

  describe("sessions", () => {
    it("writes an unanswered request again, with the same id, to the next session", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const first = plainSession(false);
      const second = plainSession();
      device.attachSession(first.session);

      const request = device.extensionRequest("x:y", null, { timeout: 100_000 });
      device.detachSession(first.session);
      assert.equal(device.pendingCount, 1);
      mock.timers.tick(10_000);
      device.attachSession(second.session);
      device.handleResponse({ t: "res", id: "r1", ok: true, result: "late" });

      assert.equal(await request, "late");
      assert.deepEqual(
        second.sent().map((frame) => [frame.id, frame.ttl]),
        [["r1", 90_000]],
      );
    });

    it("stops retransmitting to a session that was detached", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { device } = newDevice();
      const { session, sent } = plainSession(false);
      device.attachSession(session);

      const request = settled(device.extensionRequest("x:y", null, { timeout: 100_000 }));
      device.detachSession(session);
      mock.timers.tick(60_000);

      assert.equal(sent().length, 1);
      device.rejectAll(new RKError("CLOSED", "closed"));
      await request;
    });

    it("moves the unanswered requests to a new session that replaces the old one", async () => {
      const { device } = newDevice();
      const first = plainSession();
      const second = plainSession();
      device.attachSession(first.session);
      const request = settled(device.extensionRequest("x:y", null));

      device.attachSession(second.session);

      assert.equal(first.session.ended, true);
      assert.deepEqual(
        second.sent().map((frame) => frame.id),
        ["r1"],
      );
      assert.equal(device.session, second.session);
      device.rejectAll(new RKError("CLOSED", "closed"));
      await request;
    });

    it("only ends a session that is no longer the current one", () => {
      const { device } = newDevice();
      const first = plainSession();
      const second = plainSession();
      device.attachSession(first.session);
      device.attachSession(second.session);

      device.detachSession(first.session);

      assert.equal(device.session, second.session);
      assert.equal(device.status, "online");
    });

    it("rejects every request, queued or not, with the given error", async () => {
      const { device } = newDevice();
      const sentOne = device.extensionRequest("x:y", null);
      device.attachSession(plainSession().session);
      const sentTwo = device.extensionRequest("x:y", null);
      const error = new RKError("CLOSED", "closing");

      device.rejectAll(error);

      await assert.rejects(sentOne, (e) => e === error);
      await assert.rejects(sentTwo, (e) => e === error);
      assert.equal(device.pendingCount, 0);
    });
  });

  describe("chainRoomSend", () => {
    /** A send that finishes when `finish` or `fail` is called. */
    function manualSend(log: string[], name: string) {
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const promise = new Promise<string>((resolve, reject) => {
        finish = () => resolve(name);
        fail = reject;
      });
      return {
        run: () => {
          log.push(`start ${name}`);
          return promise;
        },
        finish,
        fail,
      };
    }

    it("starts a send only after the earlier ones to the same room have finished", async () => {
      const { device } = newDevice();
      const log: string[] = [];
      const a = manualSend(log, "a");
      const b = manualSend(log, "b");
      const c = manualSend(log, "c");

      const results = [
        device.chainRoomSend("app", "room", a.run),
        device.chainRoomSend("app", "room", b.run),
        device.chainRoomSend("app", "room", c.run),
      ];
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(log, ["start a"]);
      a.finish();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(log, ["start a", "start b"]);
      b.finish();
      c.finish();

      assert.deepEqual(await Promise.all(results), ["a", "b", "c"]);
      assert.deepEqual(log, ["start a", "start b", "start c"]);
    });

    it("still orders a send behind the ones in progress after an earlier send finished", async () => {
      const { device } = newDevice();
      const log: string[] = [];
      const a = manualSend(log, "a");
      const b = manualSend(log, "b");
      const c = manualSend(log, "c");

      const first = device.chainRoomSend("app", "room", a.run);
      const second = device.chainRoomSend("app", "room", b.run);
      a.finish();
      await first;
      await new Promise((resolve) => setImmediate(resolve));
      const third = device.chainRoomSend("app", "room", c.run);
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(log, ["start a", "start b"]);
      b.finish();
      c.finish();
      await Promise.all([second, third]);
      assert.deepEqual(log, ["start a", "start b", "start c"]);
    });

    it("runs the next send after one failed, and rejects only the failed one", async () => {
      const { device } = newDevice();
      const log: string[] = [];
      const a = manualSend(log, "a");
      const b = manualSend(log, "b");

      const first = device.chainRoomSend("app", "room", a.run);
      const second = device.chainRoomSend("app", "room", b.run);
      a.fail(new Error("boom"));
      b.finish();

      await assert.rejects(first, { message: "boom" });
      assert.equal(await second, "b");
    });

    it("runs the next send after one threw", async () => {
      const { device } = newDevice();

      const first = device.chainRoomSend("app", "room", () => {
        throw new Error("sync");
      });
      const second = device.chainRoomSend("app", "room", async () => "ok");

      await assert.rejects(first, { message: "sync" });
      assert.equal(await second, "ok");
    });

    it("does not make sends to other rooms wait", async () => {
      const { device } = newDevice();
      const log: string[] = [];
      const slow = manualSend(log, "slow");
      const other = manualSend(log, "other");
      const otherApp = manualSend(log, "otherApp");

      const results = [
        device.chainRoomSend("app", "room", slow.run),
        device.chainRoomSend("app", "elsewhere", other.run),
        device.chainRoomSend("other-app", "room", otherApp.run),
      ];
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(log, ["start slow", "start other", "start otherApp"]);
      slow.finish();
      other.finish();
      otherApp.finish();
      await Promise.all(results);
    });

    it("tells rooms apart even when the ids contain the separator", async () => {
      const { device } = newDevice();
      const log: string[] = [];
      const a = manualSend(log, "a");
      const b = manualSend(log, "b");

      const results = [
        device.chainRoomSend("a:b", "c", a.run),
        device.chainRoomSend("a", "b:c", b.run),
      ];
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(log, ["start a", "start b"]);
      a.finish();
      b.finish();
      await Promise.all(results);
    });
  });

  describe("acceptEvent", () => {
    it("accepts an event id once", () => {
      const { device } = newDevice();

      assert.deepEqual(
        ["a", "b", "a", "b", "c"].map((id) => device.acceptEvent(id)),
        [true, true, false, false, true],
      );
    });

    it("remembers the latest ids and forgets the oldest", () => {
      const { device } = newDevice();
      for (let i = 0; i < MAX_SEEN_EVENTS; i++) device.acceptEvent(`e${i}`);

      assert.equal(device.acceptEvent("e1"), false);
      assert.equal(device.acceptEvent("new"), true);
      assert.equal(device.acceptEvent("e0"), true);
      assert.equal(device.acceptEvent(`e${MAX_SEEN_EVENTS - 1}`), false);
    });
  });

  describe("ping", () => {
    it("rejects with DEVICE_OFFLINE without a session", async () => {
      const { device } = newDevice();

      await assert.rejects(device.ping(), (error) => isRKError(error, "DEVICE_OFFLINE"));
    });

    it("resolves with the round-trip time once the pong arrives", async () => {
      const { device } = newDevice();
      const { session } = plainSession();
      device.attachSession(session);

      const ping = device.ping();
      session.resolvePing();

      assert.equal(typeof (await ping), "number");
    });

    it("rejects with TIMEOUT, naming the device, when no pong arrives", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const { device } = newDevice();
      device.attachSession(plainSession().session);

      const ping = assert.rejects(device.ping({ timeout: 100 }), (error) => {
        assert.ok(isRKError(error, "TIMEOUT"));
        assert.equal(error.device, device);
        return true;
      });
      mock.timers.tick(100);

      await ping;
    });

    it("rejects with a RangeError for a timeout setTimeout can't take", async () => {
      const { device } = newDevice();
      device.attachSession(plainSession().session);

      await assert.rejects(device.ping({ timeout: 2 ** 31 }), RangeError);
    });
  });

  describe("call", () => {
    it("sends an extension request", async () => {
      const { device } = newDevice();
      const { session, sent } = plainSession();
      device.attachSession(session);

      const call = device.call("x:y" as never, { a: 1 } as never);
      device.handleResponse({ t: "res", id: "r1", ok: true, result: "done" });

      assert.equal(await call, "done");
      assert.equal(sent()[0]?.method, "x:y");
    });
  });

  describe("disconnect", () => {
    it("sends bye with the reason, then closes the link", async () => {
      const { device } = newDevice();
      const { session, link } = plainSession();
      const closed: Array<string | undefined> = [];
      link.close = (reason) => closed.push(reason);
      device.attachSession(session);

      device.disconnect("maintenance");
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(openFrame(link.written[0]!)?.frame, { t: "bye", reason: "maintenance" });
      assert.deepEqual(closed, ["maintenance"]);
    });

    it("sends bye without a reason when none is given", async () => {
      const { device } = newDevice();
      const { session, link } = plainSession();
      device.attachSession(session);

      device.disconnect();
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(openFrame(link.written[0]!)?.frame, { t: "bye" });
    });

    it("closes the link even when bye can't be written, without an unhandled rejection", async () => {
      const { device } = newDevice();
      const { session, link } = plainSession();
      let closed = false;
      link.close = () => (closed = true);
      link.failNext.push(new Error("closed"));
      device.attachSession(session);

      device.disconnect("x");
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(closed, true);
    });

    it("does nothing without a session", () => {
      assert.doesNotThrow(() => newDevice().device.disconnect("x"));
    });
  });
});
