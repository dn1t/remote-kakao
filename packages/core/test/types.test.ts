import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AuthOptions,
  EventName,
  EventPayload,
  ExtensionEvent,
  ExtensionMethodName,
  ExtensionParams,
  ExtensionResult,
  Listener,
  Message,
  MessageData,
  RemoteKakaoOptions,
  Room,
  RoomData,
  Sendable,
  Transport,
} from "../src/types.ts";

// This file mostly checks types. `node --test` only strips them, so the `@ts-expect-error`
// lines are verified by `tsc -p test`: if one stops being an error, tsc fails.

// The augmentations below apply to the whole test program, so their names are prefixed.
declare module "../src/types.ts" {
  interface ExtensionMethods {
    "test:send": { params: { template: number }; result: { messageId?: string } };
  }
  interface ExtensionEvents {
    "test:clicked": { room: string; user: string };
  }
}

/** Returns `value` typed as `T`, so a wrong type is a compile error at the call site. */
function accept<T>(value: T): T {
  return value;
}

const transport: Transport = {
  name: "test",
  async listen() {
    return { address: "test://", close: async () => {} };
  },
};

describe("Sendable", () => {
  it("accepts text, an image and a file", () => {
    const content: Sendable[] = [
      "hello",
      { text: "hello" },
      { image: new Uint8Array(1), caption: "c" },
      { file: new Blob(["x"]), name: "a.txt" },
    ];

    assert.equal(content.length, 4);
  });

  it("needs a name for a file", () => {
    // @ts-expect-error a file needs a name
    const content: Sendable = { file: new Uint8Array(1) };

    assert.ok(content);
  });
});

describe("extension methods", () => {
  it("are typed by augmenting ExtensionMethods", () => {
    assert.equal(accept<ExtensionMethodName>("test:send"), "test:send");
    assert.deepEqual(accept<ExtensionParams<"test:send">>({ template: 1 }), { template: 1 });
    assert.deepEqual(accept<ExtensionResult<"test:send">>({ messageId: "m" }), { messageId: "m" });
    // @ts-expect-error `template` must be a number
    accept<ExtensionParams<"test:send">>({ template: "1" });
    // @ts-expect-error a method nobody typed is not an extension method name
    accept<ExtensionMethodName>("test:unknown");
  });
});

describe("events", () => {
  it("name the built-in events and the typed extension events", () => {
    assert.equal(accept<EventName>("message"), "message");
    assert.equal(accept<EventName>("deviceConnect"), "deviceConnect");
    assert.equal(accept<EventName>("test:clicked"), "test:clicked");
    // @ts-expect-error neither built-in nor typed
    accept<EventName>("nope");
  });

  it("give each event its own payload", () => {
    const onMessage: Listener<"message"> = (message) => message.text.length;
    const onClicked: Listener<"test:clicked"> = ({ data, device }) => [data.room, device.id];
    const onError: Listener<"error"> = ({ source, device }) => [source, device?.id];
    // @ts-expect-error the payload of `message` is a Message, not a string
    const wrong: Listener<"message"> = (payload: string) => payload;
    const report: EventPayload<"error"> = {
      error: new Error("x"),
      source: "listener",
      event: "message",
      device: undefined,
    };

    assert.deepEqual(onError(report), ["listener", undefined]);
    assert.deepEqual([typeof onMessage, typeof onClicked, typeof wrong], Array(3).fill("function"));
  });

  it("wrap an extension payload with its device and app instance", () => {
    type Clicked = EventPayload<"test:clicked">;
    const same: Clicked = null as unknown as ExtensionEvent<{ room: string; user: string }>;

    assert.equal(same, null);
  });
});

describe("RemoteKakaoOptions", () => {
  it("needs transports and an explicit auth choice", () => {
    const secured: RemoteKakaoOptions = { transports: [transport], auth: { token: "secret" } };
    const open: RemoteKakaoOptions = { transports: [transport], auth: false, logger: console };

    // @ts-expect-error auth must be given, even to turn it off
    const missing: RemoteKakaoOptions = { transports: [transport] };

    assert.ok(secured && open && missing);
  });

  it("accepts a token function and a verify check", () => {
    const tokens = new Map([["phone", "secret"]]);
    const auth: AuthOptions = {
      token: (deviceId) => tokens.get(deviceId),
      verify: (hello) => hello.device.platform === "ios",
    };
    const asyncAuth: AuthOptions = { token: async (deviceId) => tokens.get(deviceId) };

    assert.equal(auth.token instanceof Function && auth.token("phone"), "secret");
    assert.ok(asyncAuth);
  });

  it("takes a partial heartbeat and no longer takes includeOwnMessages", () => {
    const base = { transports: [transport], auth: false } as const;
    const options: RemoteKakaoOptions = {
      ...base,
      requestTimeout: 10_000,
      heartbeat: { interval: 5_000 },
    };
    // Kept on one short line, so formatting can't move the error away from the directive.
    // @ts-expect-error `includeOwnMessages` was removed
    const old: RemoteKakaoOptions = { ...base, includeOwnMessages: true };

    assert.equal(options.heartbeat?.interval, 5_000);
    assert.ok(old);
  });
});

describe("entities", () => {
  // Never called: it only has to compile.
  function usage(room: Room, message: Message): unknown[] {
    // @ts-expect-error `kind` was renamed to `type`
    const kind = room.kind;
    // @ts-expect-error `fromMe` was removed
    const fromMe = message.fromMe;
    return [
      kind,
      fromMe,
      room.type,
      room.send("hello", { timeout: 1000, quote: message }),
      message.reply("pong", { quote: true }),
      room.history({ before: message, limit: 10 }),
      room.history({ before: message.id }),
      room.nextMessage({ from: message.sender, timeout: 5000 }),
      room.nextMessage({ from: message.sender.id }),
    ];
  }

  it("compile with the options they accept", () => {
    assert.equal(typeof usage, "function");
  });
});

describe("plain data", () => {
  it("describes a room and a message", () => {
    const room: RoomData = {
      ref: "r",
      id: "1",
      appInstance: "a",
      device: "d",
      type: "group",
      isGroup: true,
    };
    const message: MessageData = {
      id: "m",
      room,
      sender: { id: "u", name: "Alice" },
      type: "text",
      text: "hi",
      time: new Date(0).toISOString(),
      hasMentions: false,
      mentions: [],
      attachments: [{ type: "photo", mimeType: "image/jpeg", size: 1 }],
      replayed: false,
    };

    assert.equal(message.room.type, "group");
  });

  it("uses the renamed and removed fields", () => {
    // @ts-expect-error `kind` was renamed to `type`
    const room: RoomData = { ref: "r", id: "1", appInstance: "a", device: "d", kind: "group" };

    assert.ok(room);
  });
});
