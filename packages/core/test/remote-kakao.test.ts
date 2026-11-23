import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type { DeviceState } from "../src/device.ts";
import { isRKError, RKError } from "../src/errors.ts";
import { RemoteKakao } from "../src/remote-kakao.ts";
import type {
  Device,
  DeviceDisconnect,
  ErrorReport,
  Message,
  Plugin,
  RemoteKakaoOptions,
  Transport,
} from "../src/types.ts";
import { fakeClient, fakeTransport, flush, plainSession } from "./fakes.ts";

const transport: Transport = {
  name: "fake",
  async listen() {
    throw new Error("not used yet");
  },
};

function create(options: Partial<RemoteKakaoOptions> = {}) {
  return new RemoteKakao({ transports: [transport], auth: false, logger: false, ...options });
}

/** Room of the device `phone`, which has an open session on a fake link. */
function roomWithSession(kakao: RemoteKakao) {
  const room = kakao.room(REF_OF_PHONE);
  const device = kakao.devices.get("phone") as DeviceState;
  const link = plainSession();
  device.attachSession(link.session);
  return { room, device, ...link };
}

/** Ref of the room `r1` of the app instance `kakao` on the device `phone`. */
const REF_OF_PHONE = Buffer.from(JSON.stringify(["phone", "kakao", "r1"])).toString("base64url");

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

  describe("room", () => {
    it("gives the room of the ref, without asking the device", () => {
      const kakao = create();

      const room = kakao.room(REF_OF_PHONE);

      assert.equal(room.id, "r1");
      assert.equal(room.appInstance.id, "kakao");
      assert.equal(room.device.id, "phone");
      assert.equal(room.ref, REF_OF_PHONE);
    });

    it("makes a placeholder for a device that has not connected", () => {
      const kakao = create();

      const { device } = kakao.room(REF_OF_PHONE);

      assert.equal(kakao.devices.get("phone"), device);
      assert.deepEqual(
        [device.name, device.platform, device.client, device.status, device.protocolVersion],
        ["phone", "unknown", { name: "unknown", version: "0" }, "offline", 0],
      );
      assert.equal((device as DeviceState).described, false);
      assert.equal(device.lastSeenAt, undefined);
    });

    it("keeps the same device and app instance for every room of them", () => {
      const kakao = create();
      const ref = (device: string, appInstance: string, room: string) =>
        Buffer.from(JSON.stringify([device, appInstance, room])).toString("base64url");

      const first = kakao.room(ref("phone", "kakao", "r1"));
      const second = kakao.room(ref("phone", "kakao", "r2"));
      const other = kakao.room(ref("phone", "work", "r1"));
      const another = kakao.room(ref("tablet", "kakao", "r1"));

      assert.equal(first.device, second.device);
      assert.equal(first.appInstance, second.appInstance);
      assert.notEqual(first.appInstance, other.appInstance);
      assert.equal(first.device, other.device);
      assert.notEqual(first.device, another.device);
      assert.deepEqual([...kakao.devices.keys()], ["phone", "tablet"]);
      assert.deepEqual(
        first.device.appInstances.map((appInstance) => appInstance.id),
        ["kakao", "work"],
      );
      assert.equal(first.device.appInstance("work"), other.appInstance);
    });

    for (const ref of ["", "not a ref", Buffer.from('["a","b"]').toString("base64url")]) {
      it(`throws a TypeError for the ref "${ref}"`, () => {
        assert.throws(() => create().room(ref), { name: "TypeError", message: /room ref/ });
      });
    }
  });

  describe("requests", () => {
    it("numbers the ids of requests after a boot id, which differs between objects", async () => {
      const first = roomWithSession(create());
      const second = roomWithSession(create());

      void first.room.markRead().catch(() => {});
      void first.room.markRead().catch(() => {});
      void second.room.markRead().catch(() => {});
      await flush();

      const [one, two] = first.sent().map((frame) => frame.id);
      const [other] = second.sent().map((frame) => frame.id);
      assert.match(one!, /^[0-9a-f-]{36}-1$/);
      assert.equal(two, one!.replace(/-1$/, "-2"));
      assert.notEqual(other!.slice(0, 36), one!.slice(0, 36));
      first.device.rejectAll(new RKError("CLOSED", "closed"));
      second.device.rejectAll(new RKError("CLOSED", "closed"));
    });

    it("uses the requestTimeout option as the default deadline", async () => {
      mock.timers.enable({ apis: ["Date"], now: 0 });
      const { room, sent, device } = roomWithSession(create({ requestTimeout: 5000 }));

      void room.markRead().catch(() => {});
      await flush();

      assert.equal(sent()[0]?.ttl, 5000);
      device.rejectAll(new RKError("CLOSED", "closed"));
    });

    it("reports a request that could not be written as an error of the device", async () => {
      const kakao = create();
      const reports: ErrorReport[] = [];
      kakao.on("error", (report) => void reports.push(report));
      const { room, link, device } = roomWithSession(kakao);
      link.failNext.push(new Error("link closed"));

      void room.markRead().catch(() => {});
      await flush();

      assert.deepEqual(
        reports.map((report) => [report.source, (report.error as Error).message, report.device]),
        [["device", "link closed", device]],
      );
      device.rejectAll(new RKError("CLOSED", "closed"));
    });
  });

  describe("idle", () => {
    const answer = (device: DeviceState, id: string) =>
      device.handleResponse({ t: "res", id, ok: true, result: {} });
    const idles = (frames: Array<{ t: string } | undefined>) =>
      frames.filter((frame) => frame?.t === "idle").length;

    it("tells the client once its last request is answered", async () => {
      const { room, device, sent, frames } = roomWithSession(create());

      const first = room.markRead();
      const second = room.markRead();
      await flush();
      const [one, two] = sent().map((frame) => frame.id);
      answer(device, one!);
      await flush();
      assert.equal(idles(frames()), 0);
      answer(device, two!);
      await Promise.all([first, second]);
      await flush();

      assert.equal(idles(frames()), 1);
    });

    it("tells the client again after it has had something to do", async () => {
      const { room, device, sent, frames } = roomWithSession(create());

      for (const round of [1, 2]) {
        const call = room.markRead();
        await flush();
        answer(device, sent().at(-1)!.id);
        await call;
        await flush();
        assert.equal(idles(frames()), round);
      }
    });

    it("waits while a listener of the session is still running", async () => {
      const { room, device, session, sent, frames } = roomWithSession(create());
      session.openDispatches = 1;

      const call = room.markRead();
      await flush();
      answer(device, sent()[0]!.id);
      await call;
      await flush();

      assert.equal(idles(frames()), 0);
    });

    it("does not tell a client whose session has ended", async () => {
      const { room, device, session, sent, frames } = roomWithSession(create());

      const call = room.markRead();
      await flush();
      session.end();
      answer(device, sent()[0]!.id);
      await call;
      await flush();

      assert.equal(idles(frames()), 0);
    });

    it("is not an error when the idle can't be written", async () => {
      const kakao = create();
      const reports: ErrorReport[] = [];
      kakao.on("error", (report) => void reports.push(report));
      const { room, device, sent, link } = roomWithSession(kakao);

      const call = room.markRead();
      await flush();
      link.failNext.push(new Error("link closed"));
      answer(device, sent()[0]!.id);
      await call;
      await flush();

      assert.deepEqual(reports, []);
    });
  });

  describe("listen", () => {
    it("starts every transport, in order, and does it once", async () => {
      const order: string[] = [];
      const make = (name: string): Transport => ({
        name,
        async listen() {
          order.push(name);
          return { address: `${name}://x`, async close() {} };
        },
      });
      const kakao = new RemoteKakao({
        transports: [make("a"), make("b")],
        auth: false,
        logger: false,
      });

      await kakao.listen();
      await kakao.listen();

      assert.deepEqual(order, ["a", "b"]);
    });

    it("stops the transports it started and rejects when one fails, and can be tried again", async () => {
      const closed: string[] = [];
      let fail = true;
      const started: string[] = [];
      const good: Transport = {
        name: "good",
        async listen() {
          started.push("good");
          return {
            address: "good://x",
            async close() {
              closed.push("good");
            },
          };
        },
      };
      const bad: Transport = {
        name: "bad",
        async listen() {
          started.push("bad");
          if (fail) throw new Error("port in use");
          return { address: "bad://x", async close() {} };
        },
      };
      const kakao = new RemoteKakao({ transports: [good, bad], auth: false, logger: false });

      await assert.rejects(kakao.listen(), { message: "port in use" });
      assert.deepEqual(closed, ["good"]);
      fail = false;

      await kakao.listen();
      assert.deepEqual(started, ["good", "bad", "good", "bad"]);
    });
  });
});

const TOKEN_AUTH = { token: "secret" };

/** A started core on a fake transport. */
async function start(options: Partial<RemoteKakaoOptions> = {}) {
  const { transport, connect } = fakeTransport();
  const kakao = new RemoteKakao({
    transports: [transport],
    auth: TOKEN_AUTH,
    logger: false,
    ...options,
  });
  const connected: Device[] = [];
  const disconnected: DeviceDisconnect[] = [];
  const errors: ErrorReport[] = [];
  kakao.on("deviceConnect", (device) => void connected.push(device));
  kakao.on("deviceDisconnect", (event) => void disconnected.push(event));
  kakao.on("error", (report) => void errors.push(report));
  await kakao.listen();
  return { kakao, connect, connected, disconnected, errors };
}

/** A started core, and what its transport did. */
async function startWithState() {
  const { transport, connect, state } = fakeTransport();
  const kakao = new RemoteKakao({ transports: [transport], auth: false, logger: false });
  await kakao.listen();
  return { kakao, connect, transportState: state };
}

describe("hello", () => {
  describe("accepted", () => {
    it("answers with a welcome sealed for the device, and starts a session", async () => {
      const { kakao, connect, connected } = await start();
      const client = fakeClient();
      const link = connect();

      link.push(client.hello());
      await flush();

      const [welcome] = client.received(link);
      assert.equal(welcome?.counter, 0n);
      assert.equal(welcome?.frame.t, "welcome");
      const device = kakao.devices.get("phone")!;
      assert.deepEqual(connected, [device]);
      assert.equal(device.status, "online");
      assert.equal(device.session?.transport, "fake");
      assert.equal(device.session?.remoteAddress, "10.0.0.2:5000");
      assert.equal(
        (welcome!.frame as { session: string }).session,
        (device.session as unknown as { id: string }).id,
      );
    });

    it("works without auth, with plain frames", async () => {
      const { kakao, connect } = await start({ auth: false });
      const client = fakeClient({ token: undefined });
      const link = connect();

      link.push(client.hello());
      await flush();

      assert.equal(client.received(link)[0]?.frame.t, "welcome");
      assert.equal(client.received(link)[0]?.sealed, false);
      assert.equal(kakao.devices.get("phone")?.status, "online");
    });

    it("asks a client with no budget to ping within the heartbeat interval", async () => {
      const { connect } = await start({ heartbeat: { interval: 4000, timeout: 9000 } });
      const client = fakeClient();
      const link = connect();

      link.push(client.hello());
      await flush();

      assert.deepEqual(client.received(link)[0]?.frame, {
        t: "welcome",
        v: 1,
        session: (client.received(link)[0]!.frame as { session: string }).session,
        heartbeat: 4000,
      });
    });

    it("does not ask a client with a budget to ping", async () => {
      const { connect } = await start();
      const client = fakeClient();
      const link = connect();

      link.push(client.hello({ budget: 5000 }));
      await flush();

      const welcome = client.received(link)[0]?.frame as Record<string, unknown>;
      assert.equal("heartbeat" in welcome, false);
    });

    it("records what the hello says about the device and its app instances", async () => {
      const { kakao, connect } = await start();
      const client = fakeClient();
      const link = connect();

      link.push(
        client.hello({
          device: { id: "phone", name: "Galaxy", platform: "android" },
          client: { name: "rk-android", version: "2.0" },
          caps: ["room.send", "room.icon"],
          appInstances: [{ id: "a", me: { id: "u1", name: "Ann" } }, { id: "b" }],
        }),
      );
      await flush();

      const device = kakao.devices.get("phone")! as DeviceState;
      assert.deepEqual(
        [device.name, device.platform, device.client, device.protocolVersion, device.described],
        ["Galaxy", "android", { name: "rk-android", version: "2.0" }, 1, true],
      );
      assert.deepEqual([...device.capabilities], ["room.send", "room.icon"]);
      assert.deepEqual(
        device.appInstances.map((a) => [a.id, a.me?.id, a.me?.name, a.me?.isMe]),
        [
          ["a", "u1", "Ann", true],
          ["b", undefined, undefined, undefined],
        ],
      );
    });

    it("forgets the capabilities of the last session when the device connects again", async () => {
      const { kakao, connect } = await start();
      const first = fakeClient({ salt: Buffer.alloc(16, 1) });
      const second = fakeClient({ salt: Buffer.alloc(16, 2) });

      connect().push(first.hello({ caps: ["room.send", "room.icon"] }));
      await flush();
      connect().push(second.hello({ caps: ["room.send"] }));
      await flush();

      assert.deepEqual(
        [...(kakao.devices.get("phone") as DeviceState).capabilities],
        ["room.send"],
      );
    });

    it("writes the requests that waited for the device after the welcome", async () => {
      const { kakao, connect } = await start();
      const client = fakeClient();
      const room = kakao.room(REF_OF_PHONE);
      const call = room.markRead().catch(() => {});
      const link = connect();

      link.push(client.hello({ caps: ["room.markRead"] }));
      await flush();

      assert.deepEqual(
        client.received(link).map((opened) => opened?.frame.t),
        ["welcome", "req"],
      );
      assert.equal(kakao.devices.get("phone")?.status, "online");
      (kakao.devices.get("phone") as DeviceState).rejectAll(new RKError("CLOSED", "closed"));
      await call;
    });

    it("has the session open when deviceConnect is emitted", async () => {
      const { kakao, connect } = await start();
      const statuses: string[] = [];
      kakao.on("deviceConnect", (device) => void statuses.push(device.status));

      connect().push(fakeClient().hello());
      await flush();

      assert.deepEqual(statuses, ["online"]);
    });

    it("tells the client it can end the session when there is nothing for it to do", async () => {
      const { connect } = await start();
      const client = fakeClient();
      const link = connect();

      link.push(client.hello());
      await flush();

      assert.deepEqual(
        client.received(link).map((opened) => opened?.frame.t),
        ["welcome", "idle"],
      );
    });
  });

  describe("refused", () => {
    it("answers a version it does not speak with a reject, and closes the link", async () => {
      const { kakao, connect, connected } = await start();
      const client = fakeClient();
      const link = connect();

      link.push(client.hello({ v: 9 }));
      await flush();

      assert.deepEqual(client.received(link)[0]?.frame, {
        t: "reject",
        code: "PROTOCOL_MISMATCH",
        message: "server speaks v1",
      });
      assert.equal(client.received(link)[0]?.counter, 0n);
      assert.deepEqual(link.closed, ["PROTOCOL_MISMATCH"]);
      assert.equal(kakao.devices.size, 0);
      assert.deepEqual(connected, []);
    });

    it("answers a plain hello with a plain reject when there is no auth", async () => {
      const { connect } = await start({ auth: false });
      const client = fakeClient({ token: undefined });
      const link = connect();

      link.push(client.hello({ v: 9 }));
      await flush();

      assert.equal(client.received(link)[0]?.frame.t, "reject");
      assert.equal(client.received(link)[0]?.sealed, false);
    });

    it("says nothing and closes the link for a hello it has seen before", async () => {
      const { connect } = await start();
      const client = fakeClient();
      const hello = client.hello();
      connect().push(hello);
      await flush();
      const replay = connect();

      replay.push(hello);
      await flush();

      assert.deepEqual(replay.written, []);
      assert.deepEqual(replay.closed, ["AUTH_FAILED"]);
    });

    it("rejects a device that verify does not allow, and gives verify what the hello said", async () => {
      const seen: unknown[] = [];
      const { kakao, connect } = await start({
        auth: {
          token: "secret",
          verify: (hello) => {
            seen.push(hello.device.id, hello.transport);
            return false;
          },
        },
      });
      const client = fakeClient();
      const link = connect();

      link.push(client.hello());
      await flush();

      assert.deepEqual(seen, ["phone", "fake"]);
      assert.deepEqual(client.received(link)[0]?.frame, {
        t: "reject",
        code: "AUTH_FAILED",
        message: "rejected by verify",
      });
      assert.deepEqual(link.closed, ["AUTH_FAILED"]);
      assert.equal(kakao.devices.size, 0);
    });

    it("reports an error of verify as an error of the device, and rejects the device", async () => {
      const { connect, errors } = await start({
        auth: {
          token: "secret",
          verify: () => {
            throw new Error("database down");
          },
        },
      });
      const client = fakeClient();
      const link = connect();

      link.push(client.hello());
      await flush();

      assert.deepEqual(
        errors.map((report) => [report.source, (report.error as Error).message]),
        [["device", "database down"]],
      );
      assert.equal(client.received(link)[0]?.frame.t, "reject");
    });

    it("closes the link when the device has no token", async () => {
      const { connect } = await start({ auth: { token: () => undefined } });
      const link = connect();

      link.push(fakeClient().hello());
      await flush();

      assert.deepEqual(link.written, []);
      assert.deepEqual(link.closed, ["AUTH_FAILED"]);
    });

    it("asks for the token of the device by its id", async () => {
      const asked: string[] = [];
      const { connect } = await start({
        auth: {
          token: (device) => {
            asked.push(device);
            return "secret";
          },
        },
      });

      connect().push(fakeClient({ device: "tablet" }).hello());
      await flush();

      assert.deepEqual(asked, ["tablet"]);
    });

    it("leaves a link open that sends what does not open, such as a frame sealed with another token", async () => {
      const { connect, kakao } = await start();
      const link = connect();

      link.push(fakeClient({ token: "other" }).hello());
      await flush();

      assert.deepEqual(link.written, []);
      assert.deepEqual(link.closed, []);
      assert.equal(kakao.devices.size, 0);
    });

    it("closes the link when the first frame is not a hello", async () => {
      const { connect } = await start();
      const link = connect();

      link.push(fakeClient().seal({ t: "ping" }));
      await flush();

      assert.deepEqual(link.closed, ["PROTOCOL_ERROR"]);
    });

    it("ignores a second hello on a link that has a session", async () => {
      const { connect, connected } = await start();
      const client = fakeClient();
      const link = connect();

      link.push(client.hello());
      link.push(client.hello());
      await flush();

      assert.equal(connected.length, 1);
      assert.deepEqual(link.closed, []);
      assert.deepEqual(
        client.received(link).map((opened) => opened?.frame.t),
        ["welcome", "idle"],
      );
    });
  });

  describe("session end", () => {
    it("tells with deviceDisconnect when the link ends", async () => {
      const { kakao, connect, disconnected } = await start();
      const link = connect();
      link.push(fakeClient().hello());
      await flush();

      link.end();
      await flush();

      const device = kakao.devices.get("phone")!;
      assert.deepEqual(disconnected, [{ device, error: undefined }]);
      assert.equal(device.status, "offline");
      assert.equal(device.session, undefined);
    });

    it("tells with the error, and reports it, when the link breaks", async () => {
      const { connect, disconnected, errors } = await start();
      const link = connect();
      link.push(fakeClient().hello());
      await flush();
      const failure = new Error("connection reset");

      link.fail(failure);
      await flush();

      assert.equal(disconnected.length, 1);
      assert.ok(isRKError(disconnected[0]?.error, "PROTOCOL_ERROR"));
      assert.equal(disconnected[0]?.error?.cause, failure);
      assert.deepEqual(
        errors.map((report) => [report.source, report.error, report.device?.id]),
        [["transport", failure, "phone"]],
      );
    });

    it("does not tell about a link that never got a session", async () => {
      const { connect, disconnected } = await start();
      const link = connect();

      link.end();
      await flush();

      assert.deepEqual(disconnected, []);
    });

    it("moves to a new session when the device connects again, and closes the old link", async () => {
      const { kakao, connect, connected, disconnected } = await start();
      const first = fakeClient({ salt: Buffer.alloc(16, 1) });
      const second = fakeClient({ salt: Buffer.alloc(16, 2) });
      const oldLink = connect();
      oldLink.push(first.hello({ caps: ["room.markRead"] }));
      await flush();
      const device = kakao.devices.get("phone") as DeviceState;
      const call = kakao
        .room(REF_OF_PHONE)
        .markRead()
        .catch(() => {});
      await flush();
      const newLink = connect();

      newLink.push(second.hello({ caps: ["room.markRead"] }));
      await flush();

      assert.deepEqual(oldLink.closed, ["replaced by a new session"]);
      assert.deepEqual(disconnected, [{ device, error: undefined }]);
      assert.equal(connected.length, 2);
      assert.equal(device.status, "online");
      const requestOn = (client: ReturnType<typeof fakeClient>, link: typeof newLink) =>
        client.received(link).filter((opened) => opened?.frame.t === "req");
      assert.equal(requestOn(first, oldLink).length, 1);
      assert.deepEqual(
        requestOn(second, newLink).map((opened) => (opened!.frame as { id: string }).id),
        requestOn(first, oldLink).map((opened) => (opened!.frame as { id: string }).id),
      );
      device.rejectAll(new RKError("CLOSED", "closed"));
      await call;
    });

    it("tells that the old session ended before the new one started", async () => {
      const { kakao, connect } = await start();
      const events: string[] = [];
      kakao.on("deviceConnect", () => void events.push("connect"));
      kakao.on("deviceDisconnect", () => void events.push("disconnect"));
      connect().push(fakeClient({ salt: Buffer.alloc(16, 1) }).hello());
      await flush();

      connect().push(fakeClient({ salt: Buffer.alloc(16, 2) }).hello());
      await flush();

      assert.deepEqual(events, ["connect", "disconnect", "connect"]);
    });

    it("does not disconnect the new session when the old link ends afterwards", async () => {
      const { kakao, connect, disconnected } = await start();
      const oldLink = connect();
      oldLink.push(fakeClient({ salt: Buffer.alloc(16, 1) }).hello());
      await flush();
      connect().push(fakeClient({ salt: Buffer.alloc(16, 2) }).hello());
      await flush();

      oldLink.end();
      await flush();

      assert.equal(disconnected.length, 1);
      assert.equal(kakao.devices.get("phone")?.status, "online");
    });
  });
});

/** A core with one device that has said hello. */
async function connected(options: Partial<RemoteKakaoOptions> = {}) {
  const started = await start(options);
  const client = fakeClient();
  const link = started.connect();
  link.push(client.hello({ caps: ["room.markRead"] }));
  await flush();
  const received = () => client.received(link).map((opened) => opened?.frame);
  /** The acks Node sent, as lists of event ids. */
  const acked = () =>
    received().flatMap((frame) => (frame?.t === "ack" ? [(frame as { ids: string[] }).ids] : []));
  const device = started.kakao.devices.get("phone") as DeviceState;
  return { ...started, client, link, device, received, acked };
}

describe("frames of a session", () => {
  describe("message events", () => {
    it("emits the message, and acks the event", async () => {
      const { kakao, link, client, acked } = await connected();
      const messages: Message[] = [];
      kakao.on("message", (message) => void messages.push(message));

      link.push(client.messageEvent("e1"));
      await flush();

      assert.equal(messages.length, 1);
      const [message] = messages;
      assert.deepEqual(
        [message?.id, message?.text, message?.type, message?.replayed],
        ["m-e1", "hello", "text", false],
      );
      assert.deepEqual(
        [message?.room.id, message?.room.name, message?.room.appInstance.id, message?.sender.id],
        ["r1", "Team", "kakao", "u2"],
      );
      assert.equal(message?.room.device, kakao.devices.get("phone"));
      assert.deepEqual(acked(), [["e1"]]);
    });

    it("tells that a message was replayed from the outbox of the device", async () => {
      const { kakao, link, client } = await connected();
      const messages: Message[] = [];
      kakao.on("message", (message) => void messages.push(message));

      link.push(client.messageEvent("e1", { frame: { replay: true } }));
      await flush();

      assert.equal(messages[0]?.replayed, true);
    });

    it("emits events in the order they arrive", async () => {
      const { kakao, link, client } = await connected();
      const ids: string[] = [];
      kakao.on("message", (message) => void ids.push(message.id));

      for (const id of ["e1", "e2", "e3"]) link.push(client.messageEvent(id));
      await flush();

      assert.deepEqual(ids, ["m-e1", "m-e2", "m-e3"]);
    });

    it("emits an event once, and acks it every time the device sends it", async () => {
      const { kakao, link, client, received } = await connected();
      const ids: string[] = [];
      kakao.on("message", (message) => void ids.push(message.id));

      link.push(client.messageEvent("e1"));
      link.push(client.messageEvent("e1"));
      await flush();

      assert.deepEqual(ids, ["m-e1"]);
      assert.deepEqual(
        received().filter((frame) => frame?.t === "ack"),
        [
          { t: "ack", ids: ["e1"] },
          { t: "ack", ids: ["e1"] },
        ],
      );
    });

    it("does not emit again an event of an earlier session of the device", async () => {
      const { kakao, connect, link, client } = await connected();
      const ids: string[] = [];
      kakao.on("message", (message) => void ids.push(message.id));
      link.push(client.messageEvent("e1"));
      await flush();
      const again = fakeClient({ salt: Buffer.alloc(16, 9) });
      const secondLink = connect();
      secondLink.push(again.hello());
      await flush();

      secondLink.push(again.messageEvent("e1"));
      await flush();

      assert.deepEqual(ids, ["m-e1"]);
    });

    const invalid: Array<[string, Record<string, unknown>]> = [
      ["has no appInstance", { frame: { appInstance: undefined } }],
      ["has a text that is a number", { message: { text: 5 } }],
      ["has no room", { message: { room: undefined } }],
      ["has a time that is not a date", { message: { time: "yesterday" } }],
    ];
    for (const [title, overrides] of invalid) {
      it(`reports a message that ${title}, and acks it, without emitting it`, async () => {
        const { kakao, link, client, errors, acked } = await connected();
        const messages: Message[] = [];
        kakao.on("message", (message) => void messages.push(message));

        link.push(client.messageEvent("e1", overrides));
        await flush();

        assert.deepEqual(messages, []);
        assert.equal(errors.length, 1);
        assert.equal(errors[0]?.source, "device");
        assert.ok(isRKError(errors[0]?.error, "PROTOCOL_ERROR"));
        assert.match((errors[0]!.error as Error).message, /^device sent an invalid message: /);
        assert.deepEqual(acked(), [["e1"]]);
      });
    }

    it("keeps the session when a message is invalid", async () => {
      const { device, link, client } = await connected();

      link.push(client.messageEvent("e1", { message: { id: undefined } }));
      await flush();

      assert.equal(device.status, "online");
      assert.deepEqual(link.closed, []);
    });

    it("reports a listener that throws, and still acks", async () => {
      const { kakao, link, client, errors, acked } = await connected();
      const failure = new Error("listener failed");
      kakao.on("message", () => {
        throw failure;
      });

      link.push(client.messageEvent("e1"));
      await flush();

      assert.deepEqual(
        errors.map((report) => [report.source, report.event, report.error]),
        [["listener", "message", failure]],
      );
      assert.deepEqual(acked(), [["e1"]]);
    });
  });

  describe("idle", () => {
    const idles = (frames: Array<{ t: string } | undefined>) =>
      frames.filter((frame) => frame?.t === "idle").length;

    it("waits until the listeners of an event have finished before telling the client", async () => {
      const { kakao, link, client, received } = await connected();
      let finish!: () => void;
      kakao.on("message", () => new Promise<void>((resolve) => (finish = resolve)));
      assert.equal(idles(received()), 1);

      link.push(client.messageEvent("e1"));
      await flush();
      assert.equal(idles(received()), 1);
      finish();
      await flush();

      assert.equal(idles(received()), 2);
    });

    it("does not tell the client while a listener runs, even if a request of the device is answered", async () => {
      const { kakao, link, client, received } = await connected();
      let finish!: () => void;
      kakao.on("message", () => new Promise<void>((resolve) => (finish = resolve)));
      link.push(client.messageEvent("e1"));
      await flush();

      const call = kakao.room(REF_OF_PHONE).markRead();
      await flush();
      const request = received().find((frame) => frame?.t === "req") as { id: string };
      link.push(client.seal({ t: "res", id: request.id, ok: true, result: {} }));
      await call;
      await flush();
      assert.equal(idles(received()), 1);
      finish();
      await flush();

      assert.equal(idles(received()), 2);
    });

    it("tells the client again after each event once it is handled", async () => {
      const { kakao, link, client, received } = await connected();
      kakao.on("message", () => {});

      link.push(client.messageEvent("e1"));
      await flush();
      link.push(client.messageEvent("e2"));
      await flush();

      assert.equal(idles(received()), 3);
    });
  });

  describe("events of extensions", () => {
    it("emits the event with its device, app instance and data", async () => {
      const { kakao, link, client, device, acked } = await connected();
      const events: unknown[] = [];
      kakao.on("acme:ping" as never, (event: unknown) => void events.push(event));

      link.push(
        client.seal({
          t: "event",
          id: "x1",
          name: "acme:ping",
          appInstance: "kakao",
          data: { n: 1 },
        }),
      );
      await flush();

      assert.deepEqual(events, [
        { device, appInstance: device.appInstance("kakao"), data: { n: 1 } },
      ]);
      assert.deepEqual(acked(), [["x1"]]);
    });

    it("has no app instance when the event names none", async () => {
      const { kakao, link, client, device } = await connected();
      const events: unknown[] = [];
      kakao.on("acme:ping" as never, (event: unknown) => void events.push(event));

      link.push(client.seal({ t: "event", id: "x1", name: "acme:ping", data: 5 }));
      await flush();

      assert.deepEqual(events, [{ device, appInstance: undefined, data: 5 }]);
    });

    it("acks an event with a name it does not know, without emitting it", async () => {
      const { kakao, link, client, errors, acked } = await connected();
      const emitted: unknown[] = [];
      kakao.on("unknown" as never, (event: unknown) => void emitted.push(event));

      link.push(client.seal({ t: "event", id: "x1", name: "unknown", data: 1 } as never));
      await flush();

      assert.deepEqual(emitted, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(acked(), [["x1"]]);
    });

    it("ignores an event that has no id, without acking", async () => {
      const { link, client, received } = await connected();
      const before = received().length;

      link.push(client.seal({ t: "event", name: "message", data: {} } as never));
      await flush();

      assert.equal(received().length, before);
    });
  });

  describe("responses and requests", () => {
    it("settles the request that a res answers", async () => {
      const { kakao, link, client, received } = await connected();
      const call = kakao.room(REF_OF_PHONE).markRead();
      await flush();
      const request = received().find((frame) => frame?.t === "req") as { id: string };

      link.push(client.seal({ t: "res", id: request.id, ok: true, result: {} }));
      await flush();

      assert.equal(await call, undefined);
    });

    it("rejects the request with the code of an error res", async () => {
      const { kakao, link, client, received } = await connected();
      const call = kakao.room(REF_OF_PHONE).markRead();
      const rejected = assert.rejects(call, (error) => isRKError(error, "NOT_FOUND"));
      await flush();
      const request = received().find((frame) => frame?.t === "req") as { id: string };

      link.push(
        client.seal({
          t: "res",
          id: request.id,
          ok: false,
          error: { code: "NOT_FOUND", message: "no such room" },
        }),
      );

      await rejected;
    });

    it("answers a request of the device with UNSUPPORTED", async () => {
      const { link, client, received } = await connected();

      link.push(client.seal({ t: "req", id: "d1", method: "acme:do", params: null, ttl: 1000 }));
      await flush();

      assert.deepEqual(received().at(-1), {
        t: "res",
        id: "d1",
        ok: false,
        error: { code: "UNSUPPORTED", message: "Node has no method that devices can call" },
      });
    });
  });

  describe("ping and bye", () => {
    it("answers a ping with a pong", async () => {
      const { link, client, received } = await connected();

      link.push(client.seal({ t: "ping" }));
      await flush();

      assert.deepEqual(received().at(-1), { t: "pong" });
    });

    it("resolves the ping of device.ping() when the pong comes", async () => {
      const { kakao, link, client, received } = await connected();

      const ping = kakao.devices.get("phone")!.ping();
      await flush();
      assert.equal(received().at(-1)?.t, "ping");
      link.push(client.seal({ t: "pong" }));

      assert.equal(typeof (await ping), "number");
    });

    it("ends the session and closes the link on bye, without an error", async () => {
      const { kakao, link, client, disconnected, device } = await connected();

      link.push(client.seal({ t: "bye" }));
      await flush();

      assert.deepEqual(disconnected, [{ device, error: undefined }]);
      assert.deepEqual(link.closed, ["bye"]);
      assert.equal(kakao.devices.get("phone")?.status, "offline");
    });

    it("does not read frames that come after bye", async () => {
      const { kakao, link, client } = await connected();
      const ids: string[] = [];
      kakao.on("message", (message) => void ids.push(message.id));

      link.push(client.seal({ t: "bye" }));
      link.push(client.messageEvent("e1"));
      await flush();

      assert.deepEqual(ids, []);
    });

    it("ignores a frame sent again", async () => {
      const { link, client, received } = await connected();
      const ping = client.seal({ t: "ping" });

      link.push(ping);
      link.push(ping);
      await flush();

      assert.equal(received().filter((frame) => frame?.t === "pong").length, 1);
    });
  });
});

/** The time the clock starts at when the tests of timers mock it. */
const START = 1_700_000_000_000;

/** Like `connected`, with the timers and the clock mocked from the start. */
async function connectedWithClock(
  options: Partial<RemoteKakaoOptions> = {},
  hello: Record<string, unknown> = {},
) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const started = await start(options);
  const client = fakeClient();
  const link = started.connect();
  link.push(client.hello({ caps: ["room.markRead"], ...hello }));
  await flush();
  const device = started.kakao.devices.get("phone") as DeviceState;
  return { ...started, client, link, device };
}

/** Moves the clock, and lets what the timers started finish. */
async function tick(ms: number) {
  mock.timers.tick(ms);
  await flush();
}

describe("watching sessions", () => {
  describe("budget", () => {
    it("ends the session when the budget runs out", async () => {
      const { device, link, disconnected } = await connectedWithClock({}, { budget: 5000 });

      await tick(4999);
      assert.equal(device.status, "online");
      await tick(1);

      assert.equal(device.status, "offline");
      assert.deepEqual(disconnected, [{ device, error: undefined }]);
      assert.deepEqual(link.closed, ["budget expired"]);
    });

    it("does not end a session again that ended before the budget ran out", async () => {
      const { link, client, disconnected } = await connectedWithClock({}, { budget: 5000 });

      link.push(client.seal({ t: "bye" }));
      await flush();
      await tick(10_000);

      assert.equal(disconnected.length, 1);
      assert.deepEqual(link.closed, ["bye"]);
    });

    it("does not end a newer session of the device when an older budget runs out", async () => {
      const { kakao, connect, disconnected } = await connectedWithClock({}, { budget: 5000 });
      const second = fakeClient({ salt: Buffer.alloc(16, 2) });
      connect().push(second.hello());
      await flush();

      await tick(5000);

      assert.equal(kakao.devices.get("phone")?.status, "online");
      assert.equal(disconnected.length, 1);
    });
  });

  describe("heartbeat", () => {
    it("ends a session without a budget that sends nothing for the heartbeat timeout", async () => {
      const { device, link, disconnected } = await connectedWithClock();

      await tick(29_999);
      assert.equal(device.status, "online");
      await tick(1);

      assert.equal(device.status, "offline");
      assert.equal(disconnected.length, 1);
      assert.ok(isRKError(disconnected[0]?.error, "TIMEOUT"));
      assert.deepEqual(link.closed, ["heartbeat timeout"]);
    });

    it("uses the heartbeat timeout of the options", async () => {
      const { device } = await connectedWithClock({ heartbeat: { interval: 1000, timeout: 2500 } });

      await tick(2499);
      assert.equal(device.status, "online");
      await tick(1);

      assert.equal(device.status, "offline");
    });

    it("starts the timeout over whenever a frame arrives", async () => {
      const { device, link, client } = await connectedWithClock();

      await tick(20_000);
      link.push(client.seal({ t: "ping" }));
      await flush();
      await tick(20_000);
      assert.equal(device.status, "online");
      await tick(10_000);

      assert.equal(device.status, "offline");
    });

    it("is not kept alive by bytes that are not frames of the session", async () => {
      const { device, link, client } = await connectedWithClock();
      const replay = client.seal({ t: "ping" });
      link.push(replay);
      await flush();

      await tick(20_000);
      link.push(Buffer.from("junk"));
      link.push(replay);
      link.push(fakeClient({ token: "other" }).seal({ t: "ping" }));
      await flush();
      await tick(10_000);

      assert.equal(device.status, "offline");
    });

    it("does not time out a session with a budget", async () => {
      const { device } = await connectedWithClock({}, { budget: 200_000 });

      await tick(100_000);

      assert.equal(device.status, "online");
    });

    it("does not end a session again that ended earlier", async () => {
      const { link, client, disconnected } = await connectedWithClock();

      link.push(client.seal({ t: "bye" }));
      await flush();
      await tick(60_000);

      assert.equal(disconnected.length, 1);
      assert.deepEqual(link.closed, ["bye"]);
    });
  });

  describe("hello", () => {
    it("closes a link that sends no hello in time", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
      const { connect } = await start();
      const link = connect();

      await tick(14_999);
      assert.deepEqual(link.closed, []);
      await tick(1);

      assert.deepEqual(link.closed, ["hello timeout"]);
    });

    it("is not kept open by frames that are not a hello", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
      const { connect } = await start();
      const link = connect();

      await tick(10_000);
      link.push(fakeClient({ token: "other" }).hello());
      await flush();
      await tick(5000);

      assert.deepEqual(link.closed, ["hello timeout"]);
    });

    it("leaves a link alone that has started a session", async () => {
      const { link } = await connectedWithClock();

      await tick(20_000);

      assert.deepEqual(link.closed, []);
    });

    it("does not close a link a second time that was refused", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
      const { connect } = await start();
      const link = connect();
      link.push(fakeClient().hello({ v: 9 }));
      await flush();

      await tick(60_000);

      assert.deepEqual(link.closed, ["PROTOCOL_MISMATCH"]);
    });
  });
});

describe("close", () => {
  it("says goodbye to the devices, closes their links, and tells with deviceDisconnect", async () => {
    const { kakao, link, client, disconnected, device } = await connected();

    await kakao.close();

    const frames = client.received(link).map((opened) => opened?.frame);
    assert.deepEqual(frames.at(-1), { t: "bye", reason: "server closing" });
    assert.deepEqual(link.closed, ["server closing"]);
    assert.deepEqual(disconnected, [{ device, error: undefined }]);
    assert.equal(device.status, "offline");
  });

  it("stops the transports", async () => {
    const { kakao, transportState } = await startWithState();

    await kakao.close();

    assert.equal(transportState.closed, true);
  });

  it("rejects the requests that are still waiting with CLOSED", async () => {
    const { kakao } = await connected();
    const call = kakao.room(REF_OF_PHONE).markRead();
    const rejected = assert.rejects(call, (error) => isRKError(error, "CLOSED"));

    await kakao.close();

    await rejected;
  });

  it("makes wait reject with CLOSED, and calls no listener any more", async () => {
    const { kakao } = await connected();
    const waiting = assert.rejects(kakao.wait("message"), (error) => isRKError(error, "CLOSED"));

    await kakao.close();

    await waiting;
    await assert.rejects(kakao.wait("message"), (error) => isRKError(error, "CLOSED"));
  });

  it("does the same when called again, and gives the same promise", async () => {
    const { kakao, link } = await connected();

    const first = kakao.close();
    const second = kakao.close();
    await Promise.all([first, second]);

    assert.equal(first, second);
    assert.deepEqual(link.closed, ["server closing"]);
  });

  it("works as asyncDispose", async () => {
    const { kakao, device } = await connected();

    await kakao[Symbol.asyncDispose]();

    assert.equal(device.status, "offline");
  });

  it("refuses to listen again, and closes links that come in", async () => {
    const { kakao, connect } = await connected();
    await kakao.close();

    await assert.rejects(kakao.listen(), (error) => isRKError(error, "CLOSED"));
    assert.deepEqual(connect().closed, ["closed"]);
  });

  it("waits for a listener that is running, and returns when it finishes", async () => {
    const { kakao, link, client } = await connected();
    let finish!: () => void;
    let finished = false;
    kakao.on("message", async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      finished = true;
    });
    link.push(client.messageEvent("e1"));
    await flush();

    let closed = false;
    const closing = kakao.close().then(() => (closed = true));
    await flush();
    assert.equal(closed, false);
    finish();
    await closing;

    assert.equal(finished, true);
  });

  it("stops waiting for a listener that does not finish after the timeout", async () => {
    const { kakao, link, client } = await connectedWithClock();
    kakao.on("message", () => new Promise<void>(() => {}));
    link.push(client.messageEvent("e1"));
    await flush();

    const closing = kakao.close({ timeout: 100 });
    await flush();
    mock.timers.tick(100);

    await closing;
  });

  it("refuses a timeout that a timer can't wait for", async () => {
    const { kakao } = await connected();

    await assert.rejects(kakao.close({ timeout: -1 }), RangeError);
  });

  it("closes the links that do not end by themselves", async () => {
    const { kakao, connect } = await start();
    const silent = connect();

    await kakao.close();

    assert.deepEqual(silent.closed, ["closed"]);
  });
});

describe("listen with a signal", () => {
  it("rejects without starting anything when the signal is already aborted", async () => {
    const { transport, state } = fakeTransport();
    const kakao = new RemoteKakao({ transports: [transport], auth: false, logger: false });
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await assert.rejects(kakao.listen({ signal: controller.signal }), { message: "stop" });

    assert.equal(state.listening, false);
  });

  it("closes when the signal is aborted", async () => {
    const { transport, state } = fakeTransport();
    const kakao = new RemoteKakao({ transports: [transport], auth: false, logger: false });
    const controller = new AbortController();
    await kakao.listen({ signal: controller.signal });

    controller.abort();
    await flush();

    assert.equal(state.closed, true);
    await assert.rejects(kakao.wait("message"), (error) => isRKError(error, "CLOSED"));
  });
});

describe("plugins", () => {
  /** A plugin that logs when it is set up and cleaned up. */
  function loggedPlugin(log: string[], name: string, options: { async?: boolean } = {}): Plugin {
    return {
      name,
      async setup() {
        log.push(`setup ${name}`);
        if (options.async) await flush();
        log.push(`ready ${name}`);
        return () => void log.push(`cleanup ${name}`);
      },
    };
  }

  /** A core on a transport that can start, not started yet. */
  function create() {
    return new RemoteKakao({ transports: [fakeTransport().transport], auth: false, logger: false });
  }

  function loggedKakao(log: string[]) {
    const transport: Transport = {
      name: "fake",
      async listen() {
        log.push("transport");
        return { address: "fake://x", async close() {} };
      },
    };
    return new RemoteKakao({ transports: [transport], auth: false, logger: false });
  }

  it("sets plugins up in order, one after the other, before the transports start", async () => {
    const log: string[] = [];
    const kakao = loggedKakao(log);
    kakao.use(loggedPlugin(log, "a", { async: true })).use(loggedPlugin(log, "b"));

    await kakao.listen();

    assert.deepEqual(log, ["setup a", "ready a", "setup b", "ready b", "transport"]);
  });

  it("gives the plugin the RemoteKakao it was added to", async () => {
    const kakao = create();
    const received: unknown[] = [];
    kakao.use({ name: "p", setup: (rk) => void received.push(rk) });

    await kakao.listen();

    assert.deepEqual(received, [kakao]);
  });

  it("lets a plugin listen to events, and stop with the function it returns", async () => {
    const { transport, connect } = fakeTransport();
    const kakao = new RemoteKakao({ transports: [transport], auth: false, logger: false });
    const seen: string[] = [];
    kakao.use({
      name: "watcher",
      setup: (rk) => rk.on("deviceConnect", (device) => void seen.push(device.id)),
    });
    await kakao.listen();

    connect().push(fakeClient({ token: undefined }).hello());
    await flush();
    await kakao.close();

    assert.deepEqual(seen, ["phone"]);
  });

  it("sets up a plugin at once when it is added after listen, and does not do it twice", async () => {
    const log: string[] = [];
    const kakao = loggedKakao(log);
    await kakao.listen();
    const plugin = loggedPlugin(log, "late");

    kakao.use(plugin).use(plugin);
    await flush();

    assert.deepEqual(log, ["transport", "setup late", "ready late"]);
  });

  it("sets a plugin up once when it is added while listen is setting up the others", async () => {
    const log: string[] = [];
    const kakao = loggedKakao(log);
    const slow: Plugin = {
      name: "slow",
      async setup() {
        log.push("setup slow");
        await flush();
      },
    };
    kakao.use(slow);

    const listening = kakao.listen();
    kakao.use(loggedPlugin(log, "added"));
    await listening;

    assert.deepEqual(log, ["setup slow", "setup added", "ready added", "transport"]);
  });

  it("returns this from use, and refuses what is not a plugin", () => {
    const kakao = create();

    assert.equal(kakao.use({ name: "p", setup() {} }), kakao);
    for (const plugin of [undefined, null, {}, { name: "p" }, { setup() {} }, "plugin"]) {
      assert.throws(() => kakao.use(plugin as never), TypeError);
    }
  });

  it("calls the cleanups when closing, the last plugin first, after the sessions ended", async () => {
    const log: string[] = [];
    const { transport, connect } = fakeTransport();
    const kakao = new RemoteKakao({ transports: [transport], auth: false, logger: false });
    kakao.use(loggedPlugin(log, "a")).use(loggedPlugin(log, "b"));
    kakao.on("deviceDisconnect", () => void log.push("disconnect"));
    await kakao.listen();
    connect().push(fakeClient({ token: undefined }).hello());
    await flush();
    log.length = 0;

    await kakao.close();

    assert.deepEqual(log, ["disconnect", "cleanup b", "cleanup a"]);
  });

  it("does not need a plugin to return a cleanup", async () => {
    const kakao = create();
    kakao.use({ name: "quiet", setup() {} }).use({ name: "async", async setup() {} });
    await kakao.listen();

    await assert.doesNotReject(kakao.close());
  });

  it("reports a cleanup that fails, and still runs the others", async () => {
    const log: string[] = [];
    const kakao = create();
    const errors: ErrorReport[] = [];
    kakao.on("error", (report) => void errors.push(report));
    const failure = new Error("cleanup failed");
    kakao.use(loggedPlugin(log, "a")).use({
      name: "bad",
      setup: () => () => {
        throw failure;
      },
    });
    await kakao.listen();

    await kakao.close();

    assert.deepEqual(log, ["setup a", "ready a", "cleanup a"]);
    assert.deepEqual(
      errors.map((report) => [report.source, report.error]),
      [["plugin", failure]],
    );
  });

  it("makes listen reject when a setup fails, undoes the plugins before it, and sets them up again on the next try", async () => {
    const log: string[] = [];
    const kakao = loggedKakao(log);
    let fail = true;
    kakao.use(loggedPlugin(log, "a")).use({
      name: "flaky",
      setup() {
        if (fail) throw new Error("setup failed");
        log.push("flaky ok");
      },
    });

    await assert.rejects(kakao.listen(), { message: "setup failed" });
    assert.deepEqual(log, ["setup a", "ready a", "cleanup a"]);
    fail = false;
    await kakao.listen();

    assert.deepEqual(log.slice(3), ["setup a", "ready a", "flaky ok", "transport"]);
  });

  it("does not start the transports when a setup fails", async () => {
    const { transport, state } = fakeTransport();
    const kakao = new RemoteKakao({ transports: [transport], auth: false, logger: false });
    kakao.use({
      name: "bad",
      setup() {
        throw new Error("nope");
      },
    });

    await assert.rejects(kakao.listen());

    assert.equal(state.listening, false);
  });

  it("reports a setup that fails after listen as an error of the plugin", async () => {
    const kakao = create();
    const errors: ErrorReport[] = [];
    kakao.on("error", (report) => void errors.push(report));
    await kakao.listen();
    const failure = new Error("setup failed");

    kakao.use({
      name: "late-bad",
      async setup() {
        throw failure;
      },
    });
    await flush();

    assert.deepEqual(
      errors.map((report) => [report.source, report.error]),
      [["plugin", failure]],
    );
  });

  it("cleans up a plugin whose setup finishes after close", async () => {
    const log: string[] = [];
    const kakao = create();
    await kakao.listen();
    let finish!: () => void;
    kakao.use({
      name: "slow",
      setup: () =>
        new Promise((resolve) => {
          finish = () => resolve(() => void log.push("cleanup slow"));
        }),
    });
    await flush();

    await kakao.close();
    finish();
    await flush();

    assert.deepEqual(log, ["cleanup slow"]);
  });

  it("refuses a plugin after close", async () => {
    const kakao = create();
    await kakao.close();

    assert.throws(
      () => kakao.use({ name: "p", setup() {} }),
      (error) => isRKError(error, "CLOSED"),
    );
  });
});
