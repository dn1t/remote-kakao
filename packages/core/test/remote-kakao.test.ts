import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type { DeviceState } from "../src/device.ts";
import { isRKError, RKError } from "../src/errors.ts";
import { RemoteKakao } from "../src/remote-kakao.ts";
import type { ErrorReport, RemoteKakaoOptions, Transport } from "../src/types.ts";
import { flush, plainSession } from "./fakes.ts";

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
});
