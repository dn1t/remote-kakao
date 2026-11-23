import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { decodeRef } from "../src/convert.ts";
import { AppInstanceImpl, requireCapability, RoomImpl, UserImpl } from "../src/entities.ts";
import { isRKError, RKError } from "../src/errors.ts";
import type { Capability } from "../src/protocol.ts";
import type { Message } from "../src/types.ts";
import { flush, newDevice, plainSession } from "./fakes.ts";

/**
 * Makes an app instance on an online device.
 * `sent()` returns the requests written to the device.
 */
function setUp(options: { described?: boolean; capabilities?: Capability[] } = {}) {
  const { device } = newDevice();
  const { session, sent } = plainSession();
  device.attachSession(session);
  device.described = options.described ?? true;
  for (const capability of options.capabilities ?? []) device.capabilities.add(capability);
  const appInstance = new AppInstanceImpl(device, "kakao");
  return { device, appInstance, sent };
}

describe("requireCapability", () => {
  it("throws UNSUPPORTED, naming the device, when a described device lacks the capability", () => {
    const { device } = setUp({ capabilities: ["room.send"] });

    assert.throws(
      () => requireCapability(device, "room.icon"),
      (error) => {
        assert.ok(isRKError(error, "UNSUPPORTED"));
        assert.equal(error.device, device);
        assert.equal(error.message, 'device does not support "room.icon"');
        return true;
      },
    );
  });

  it("lets a described device that has the capability through", () => {
    const { device } = setUp({ capabilities: ["room.icon"] });

    assert.doesNotThrow(() => requireCapability(device, "room.icon"));
  });

  it("lets everything through for a device that has not connected yet", () => {
    const { device } = setUp({ described: false });

    assert.doesNotThrow(() => requireCapability(device, "room.icon"));
  });
});

describe("AppInstanceImpl", () => {
  it("has its id and device, and no user until it is set", () => {
    const { device, appInstance } = setUp();

    assert.equal(appInstance.id, "kakao");
    assert.equal(appInstance.device, device);
    assert.equal(appInstance.me, undefined);
  });
});

describe("UserImpl", () => {
  it("has the id and name from the wire, and its app instance", () => {
    const { appInstance } = setUp();

    const user = new UserImpl(appInstance, { id: "u1", name: "Ann" });

    assert.equal(user.id, "u1");
    assert.equal(user.name, "Ann");
    assert.equal(user.appInstance, appInstance);
  });

  it("serializes to its id and name", () => {
    const { appInstance } = setUp();
    const user = new UserImpl(appInstance, { id: "u1", name: "Ann" });

    assert.deepEqual(user.toJSON(), { id: "u1", name: "Ann" });
    assert.equal(JSON.stringify({ user }), '{"user":{"id":"u1","name":"Ann"}}');
  });

  describe("isMe", () => {
    it("is true for the user the app instance is signed in as", () => {
      const { appInstance } = setUp();
      appInstance.me = new UserImpl(appInstance, { id: "u1", name: "Ann" });

      assert.equal(new UserImpl(appInstance, { id: "u1", name: "Ann" }).isMe, true);
      assert.equal(new UserImpl(appInstance, { id: "u2", name: "Bob" }).isMe, false);
    });

    it("is false when the app instance does not know who is signed in", () => {
      const { appInstance } = setUp();

      assert.equal(new UserImpl(appInstance, { id: "u1", name: "Ann" }).isMe, false);
    });

    it("follows the user the app instance is signed in as at the time it is read", () => {
      const { appInstance } = setUp();
      const user = new UserImpl(appInstance, { id: "u1", name: "Ann" });

      appInstance.me = user;
      assert.equal(user.isMe, true);
      appInstance.me = new UserImpl(appInstance, { id: "u2", name: "Bob" });
      assert.equal(user.isMe, false);
    });
  });

  describe("avatar", () => {
    it("asks the device for the avatar and returns it as a Blob", async () => {
      const { device, appInstance, sent } = setUp({ capabilities: ["user.avatar"] });
      const user = new UserImpl(appInstance, { id: "u1", name: "Ann" });

      const avatar = user.avatar();
      await Promise.resolve();
      device.handleResponse({
        t: "res",
        id: "r1",
        ok: true,
        result: { image: { mime: "image/png", base64: Buffer.from("png").toString("base64") } },
      });

      const blob = await avatar;
      assert.equal(blob?.type, "image/png");
      assert.equal(await blob?.text(), "png");
      assert.deepEqual(
        sent().map((frame) => [frame.method, frame.params]),
        [["user.avatar", { appInstance: "kakao", user: "u1" }]],
      );
    });

    it("resolves with undefined when the user has no avatar", async () => {
      const { device, appInstance } = setUp({ capabilities: ["user.avatar"] });

      const avatar = new UserImpl(appInstance, { id: "u1", name: "Ann" }).avatar();
      await Promise.resolve();
      device.handleResponse({ t: "res", id: "r1", ok: true, result: {} });

      assert.equal(await avatar, undefined);
    });

    it("passes the timeout and the signal on to the request", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { appInstance, sent } = setUp({ capabilities: ["user.avatar"] });
      const user = new UserImpl(appInstance, { id: "u1", name: "Ann" });
      const controller = new AbortController();

      const avatar = user.avatar({ timeout: 5000, signal: controller.signal });
      await Promise.resolve();
      controller.abort();

      assert.equal(sent()[0]?.ttl, 5000);
      await assert.rejects(avatar, (error) => isRKError(error, "ABORTED"));
      mock.timers.reset();
    });

    it("rejects with UNSUPPORTED, without asking, when the device lacks user.avatar", async () => {
      const { appInstance, sent } = setUp({ capabilities: ["room.send"] });

      await assert.rejects(new UserImpl(appInstance, { id: "u1", name: "Ann" }).avatar(), (error) =>
        isRKError(error, "UNSUPPORTED"),
      );

      assert.deepEqual(sent(), []);
    });

    it("asks a device that has not connected yet, and lets it answer", async () => {
      const { appInstance, sent } = setUp({ described: false });
      const user = new UserImpl(appInstance, { id: "u1", name: "Ann" });

      void user.avatar().catch(() => {});
      await Promise.resolve();

      assert.equal(sent().length, 1);
      appInstance.device.rejectAll(new RKError("CLOSED", "closed"));
    });
  });
});

const IMAGE = { mime: "image/png", base64: Buffer.from("png").toString("base64") };

describe("AppInstanceImpl rooms", () => {
  it("gives the room with the id without asking the device", () => {
    const { appInstance, sent } = setUp();

    const room = appInstance.room("r1");

    assert.ok(room instanceof RoomImpl);
    assert.equal(room.id, "r1");
    assert.equal(room.appInstance, appInstance);
    assert.deepEqual(sent(), []);
  });

  it("lists the rooms the device reports", async () => {
    const { device, appInstance, sent } = setUp({ capabilities: ["room.list"] });

    const rooms = appInstance.rooms();
    await flush();
    device.handleResponse({
      t: "res",
      id: "r1",
      ok: true,
      result: {
        rooms: [{ id: "a", name: "Team", type: "group", isGroup: true }, { id: "b" }],
      },
    });

    const result = await rooms;
    assert.deepEqual(
      result.map((room) => [room.id, room.name, room.isGroup, room.type, room.appInstance]),
      [
        ["a", "Team", true, "group", appInstance],
        ["b", undefined, undefined, "unknown", appInstance],
      ],
    );
    assert.deepEqual(
      sent().map((frame) => [frame.method, frame.params]),
      [["room.list", { appInstance: "kakao" }]],
    );
  });

  it("passes the timeout on to the request", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { device, appInstance, sent } = setUp({ capabilities: ["room.list"] });

    const rooms = appInstance.rooms({ timeout: 5000 });
    await flush();
    device.handleResponse({ t: "res", id: "r1", ok: true, result: { rooms: [] } });
    await rooms;

    assert.equal(sent()[0]?.ttl, 5000);
    mock.timers.reset();
  });

  it("rejects with UNSUPPORTED, without asking, when the device lacks room.list", async () => {
    const { appInstance, sent } = setUp({ capabilities: [] });

    await assert.rejects(appInstance.rooms(), (error) => isRKError(error, "UNSUPPORTED"));

    assert.deepEqual(sent(), []);
  });
});

describe("RoomImpl", () => {
  it("has what the device described, and defaults for what it did not", () => {
    const { device, appInstance } = setUp();

    const described = new RoomImpl(appInstance, {
      id: "r1",
      name: "Team",
      type: "open-group",
      isGroup: true,
    });
    const bare = new RoomImpl(appInstance, { id: "r2" });

    assert.deepEqual(
      [described.id, described.name, described.type, described.isGroup],
      ["r1", "Team", "open-group", true],
    );
    assert.deepEqual(
      [bare.id, bare.name, bare.type, bare.isGroup],
      ["r2", undefined, "unknown", undefined],
    );
    assert.equal(described.appInstance, appInstance);
    assert.equal(described.device, device);
  });

  it("has a ref that holds the device, app instance and room ids", () => {
    const { appInstance } = setUp();

    const room = new RoomImpl(appInstance, { id: "r1" });

    assert.deepEqual(decodeRef(room.ref), { device: "phone", appInstance: "kakao", room: "r1" });
    assert.equal(new RoomImpl(appInstance, { id: "r1", name: "Other" }).ref, room.ref);
    assert.notEqual(new RoomImpl(appInstance, { id: "r2" }).ref, room.ref);
  });

  it("asks the device what it supports", () => {
    const { appInstance } = setUp({ capabilities: ["room.icon"] });
    const room = new RoomImpl(appInstance, { id: "r1" });

    assert.equal(room.supports("room.icon"), true);
    assert.equal(room.supports("room.send"), false);
  });

  describe("toJSON", () => {
    it("has the ids, ref and type, and the name and group flag when known", () => {
      const { appInstance } = setUp();
      const room = new RoomImpl(appInstance, { id: "r1", name: "Team", isGroup: false });

      assert.deepEqual(room.toJSON(), {
        ref: room.ref,
        id: "r1",
        appInstance: "kakao",
        device: "phone",
        type: "unknown",
        name: "Team",
        isGroup: false,
      });
    });

    it("leaves out the name and group flag when unknown", () => {
      const { appInstance } = setUp();
      const room = new RoomImpl(appInstance, { id: "r1" });

      assert.deepEqual(Object.keys(room.toJSON()).sort(), [
        "appInstance",
        "device",
        "id",
        "ref",
        "type",
      ]);
    });
  });

  describe("send", () => {
    it("sends text, as a string or as an object, and returns the message id", async () => {
      const { device, appInstance, sent } = setUp({ capabilities: ["room.send"] });
      const room = appInstance.room("r1");

      const first = room.send("hello");
      await flush();
      device.handleResponse({ t: "res", id: "r1", ok: true, result: { messageId: "m1" } });
      const second = room.send({ text: "again" });
      await flush();
      device.handleResponse({ t: "res", id: "r2", ok: true, result: {} });

      assert.deepEqual(await first, { messageId: "m1" });
      assert.deepEqual(await second, { messageId: undefined });
      assert.deepEqual(
        sent().map((frame) => [frame.method, frame.params]),
        [
          ["room.send", { appInstance: "kakao", room: "r1", content: { text: "hello" } }],
          ["room.send", { appInstance: "kakao", room: "r1", content: { text: "again" } }],
        ],
      );
    });

    it("sends an image or a file as base64 when the device supports it", async () => {
      const { device, appInstance, sent } = setUp({
        capabilities: ["room.send", "send.image", "send.file"],
      });
      const room = appInstance.room("r1");

      const image = room.send({ image: new Blob(["png"], { type: "image/png" }), caption: "hi" });
      await flush();
      device.handleResponse({ t: "res", id: "r1", ok: true, result: {} });
      const file = room.send({ file: new Uint8Array([1, 2]), name: "a.bin" });
      await flush();
      device.handleResponse({ t: "res", id: "r2", ok: true, result: {} });
      await Promise.all([image, file]);

      assert.deepEqual(
        sent().map((frame) => (frame.params as { content: unknown }).content),
        [
          { image: IMAGE, caption: "hi" },
          { file: { mime: "application/octet-stream", base64: "AQI=" }, name: "a.bin" },
        ],
      );
    });

    it("sends the id of the message to quote", async () => {
      const { device, appInstance, sent } = setUp({ capabilities: ["room.send", "send.quote"] });

      const result = appInstance.room("r1").send("re", { quote: { id: "m9" } as Message });
      await flush();
      device.handleResponse({ t: "res", id: "r1", ok: true, result: {} });
      await result;

      assert.deepEqual(sent()[0]?.params, {
        appInstance: "kakao",
        room: "r1",
        content: { text: "re" },
        quote: "m9",
      });
    });

    const unsupported: Array<[string, Capability[], Parameters<RoomImpl["send"]>]> = [
      ["text without room.send", ["send.image"], ["hi"]],
      ["an image without send.image", ["room.send"], [{ image: new Uint8Array(1) }]],
      ["a file without send.file", ["room.send"], [{ file: new Uint8Array(1), name: "a" }]],
      ["a quote without send.quote", ["room.send"], ["hi", { quote: { id: "m1" } as Message }]],
    ];
    for (const [title, capabilities, args] of unsupported) {
      it(`rejects with UNSUPPORTED, without asking, for ${title}`, async () => {
        const { appInstance, sent } = setUp({ capabilities });

        await assert.rejects(appInstance.room("r1").send(...args), (error) =>
          isRKError(error, "UNSUPPORTED"),
        );

        assert.deepEqual(sent(), []);
      });
    }

    it("rejects with a TypeError, without asking, for content it can't send", async () => {
      const { appInstance, sent } = setUp({ capabilities: ["room.send"] });

      await assert.rejects(appInstance.room("r1").send(""), TypeError);

      assert.deepEqual(sent(), []);
    });

    it("writes the sends to a room one at a time, in the order they were called", async () => {
      const { device, appInstance, sent } = setUp({ capabilities: ["room.send"] });
      const room = appInstance.room("r1");

      const results = [room.send("1"), room.send("2"), room.send("3")];
      await flush();
      assert.equal(sent().length, 1);
      device.handleResponse({ t: "res", id: "r1", ok: true, result: {} });
      await flush();
      assert.equal(sent().length, 2);
      device.handleResponse({ t: "res", id: "r2", ok: true, result: {} });
      await flush();
      device.handleResponse({ t: "res", id: "r3", ok: true, result: {} });
      await Promise.all(results);

      assert.deepEqual(
        sent().map((frame) => (frame.params as { content: unknown }).content),
        [{ text: "1" }, { text: "2" }, { text: "3" }],
      );
    });

    it("does not make a send to another room wait", async () => {
      const { device, appInstance, sent } = setUp({ capabilities: ["room.send"] });

      const first = appInstance.room("a").send("1");
      const second = appInstance.room("b").send("2");
      await flush();

      assert.equal(sent().length, 2);
      device.rejectAll(new RKError("CLOSED", "closed"));
      await Promise.allSettled([first, second]);
    });

    it("sends the next message after one failed", async () => {
      const { device, appInstance } = setUp({ capabilities: ["room.send"] });
      const room = appInstance.room("r1");

      const first = room.send("1");
      const second = room.send("2");
      await flush();
      device.handleResponse({
        t: "res",
        id: "r1",
        ok: false,
        error: { code: "UNREACHABLE", message: "offline" },
      });
      await flush();
      device.handleResponse({ t: "res", id: "r2", ok: true, result: { messageId: "m2" } });

      await assert.rejects(first, (error) => isRKError(error, "UNREACHABLE"));
      assert.deepEqual(await second, { messageId: "m2" });
    });

    it("passes the timeout and the signal on to the request", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { appInstance, sent } = setUp({ capabilities: ["room.send"] });
      const controller = new AbortController();

      const result = appInstance
        .room("r1")
        .send("hi", { timeout: 5000, signal: controller.signal });
      await flush();
      controller.abort();

      assert.equal(sent()[0]?.ttl, 5000);
      await assert.rejects(result, (error) => isRKError(error, "ABORTED"));
      mock.timers.reset();
    });
  });

  describe("markRead, icon and members", () => {
    it("markRead asks the device to mark the room as read", async () => {
      const { device, appInstance, sent } = setUp({ capabilities: ["room.markRead"] });

      const result = appInstance.room("r1").markRead();
      await flush();
      device.handleResponse({ t: "res", id: "r1", ok: true, result: {} });

      assert.equal(await result, undefined);
      assert.deepEqual(
        sent().map((frame) => [frame.method, frame.params]),
        [["room.markRead", { appInstance: "kakao", room: "r1" }]],
      );
    });

    it("icon returns the icon as a Blob, or undefined when there is none", async () => {
      const { device, appInstance, sent } = setUp({ capabilities: ["room.icon"] });
      const room = appInstance.room("r1");

      const withIcon = room.icon();
      await flush();
      device.handleResponse({ t: "res", id: "r1", ok: true, result: { image: IMAGE } });
      const withoutIcon = room.icon();
      await flush();
      device.handleResponse({ t: "res", id: "r2", ok: true, result: {} });

      const blob = await withIcon;
      assert.equal(blob?.type, "image/png");
      assert.equal(await blob?.text(), "png");
      assert.equal(await withoutIcon, undefined);
      assert.equal(sent()[0]?.method, "room.icon");
      assert.deepEqual(sent()[0]?.params, { appInstance: "kakao", room: "r1" });
    });

    it("members returns the users of the room in the same app instance", async () => {
      const { device, appInstance, sent } = setUp({ capabilities: ["room.members"] });
      appInstance.me = new UserImpl(appInstance, { id: "u1", name: "Ann" });

      const members = appInstance.room("r1").members();
      await flush();
      device.handleResponse({
        t: "res",
        id: "r1",
        ok: true,
        result: {
          users: [
            { id: "u1", name: "Ann" },
            { id: "u2", name: "Bob" },
          ],
        },
      });

      const users = await members;
      assert.ok(
        users.every((user) => user instanceof UserImpl && user.appInstance === appInstance),
      );
      assert.deepEqual(
        users.map((user) => [user.id, user.name, user.isMe]),
        [
          ["u1", "Ann", true],
          ["u2", "Bob", false],
        ],
      );
      assert.deepEqual(sent()[0]?.params, { appInstance: "kakao", room: "r1" });
    });

    const calls: Array<[string, (room: RoomImpl) => Promise<unknown>]> = [
      ["room.markRead", (room) => room.markRead()],
      ["room.icon", (room) => room.icon()],
      ["room.members", (room) => room.members()],
    ];
    for (const [capability, call] of calls) {
      it(`${capability} rejects with UNSUPPORTED, without asking, when the device lacks it`, async () => {
        const { appInstance, sent } = setUp({ capabilities: ["room.send"] });

        await assert.rejects(call(appInstance.room("r1")), (error) =>
          isRKError(error, "UNSUPPORTED"),
        );

        assert.deepEqual(sent(), []);
      });
    }
  });
});
