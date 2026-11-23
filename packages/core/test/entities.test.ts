import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { AppInstanceImpl, requireCapability, UserImpl } from "../src/entities.ts";
import { isRKError, RKError } from "../src/errors.ts";
import type { Capability } from "../src/protocol.ts";
import { newDevice, plainSession } from "./fakes.ts";

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
