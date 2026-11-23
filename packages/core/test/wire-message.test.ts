import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WireMessage } from "../src/protocol.ts";
import { isWireMessage, wireMessageProblem } from "../src/wire-message.ts";

const message = (overrides: Record<string, unknown> = {}): unknown => ({
  id: "m1",
  room: { id: "r1" },
  sender: { id: "u1", name: "Ann" },
  type: "text",
  text: "hello",
  time: 1_700_000_000_000,
  ...overrides,
});

describe("wireMessageProblem", () => {
  it("accepts a message with only the required fields", () => {
    assert.equal(wireMessageProblem(message()), undefined);
  });

  it("accepts a message with every field", () => {
    const full = message({
      room: { id: "r1", name: "Team", type: "group", isGroup: true },
      hasMentions: true,
      mentions: [{ id: "u2", name: "Bob" }],
      attachments: [{ type: "photo", name: "a.png", mime: "image/png", size: 3 }, { type: "file" }],
      quoted: { id: "m0", text: "earlier", sender: { id: "u2", name: "Bob" } },
      raw: { anything: [1, 2] },
    });

    assert.equal(wireMessageProblem(full), undefined);
    assert.equal(isWireMessage(full), true);
  });

  it("accepts a type or room type it does not know, which clients may add", () => {
    assert.equal(
      wireMessageProblem(message({ type: "poll", room: { id: "r", type: "forum" } })),
      undefined,
    );
  });

  it("accepts the earliest and the latest time a Date can hold", () => {
    assert.equal(wireMessageProblem(message({ time: -8.64e15 })), undefined);
    assert.equal(wireMessageProblem(message({ time: 8.64e15 })), undefined);
  });

  const broken: Array<[string, unknown, string]> = [
    ["null", null, "message is not an object"],
    ["a string", "hi", "message is not an object"],
    ["a list", [], "message is not an object"],
    ["no id", message({ id: undefined }), "message has no id"],
    ["an id that is a number", message({ id: 1 }), "message has no id"],
    ["no type", message({ type: undefined }), "message has no type"],
    ["no text", message({ text: undefined }), "message has no text"],
    ["a text that is a number", message({ text: 5 }), "message has no text"],
    ["no time", message({ time: undefined }), "message has no valid time"],
    ["a time that is a string", message({ time: "now" }), "message has no valid time"],
    ["a time that is not a number", message({ time: Number.NaN }), "message has no valid time"],
    [
      "a time past what a Date can hold",
      message({ time: 8.64e15 + 1 }),
      "message has no valid time",
    ],
    ["an infinite time", message({ time: Infinity }), "message has no valid time"],
    ["no room", message({ room: undefined }), "message has no valid room"],
    ["a room without an id", message({ room: {} }), "message has no valid room"],
    [
      "a room name that is a number",
      message({ room: { id: "r", name: 1 } }),
      "message has no valid room",
    ],
    [
      "a room isGroup that is a string",
      message({ room: { id: "r", isGroup: "yes" } }),
      "message has no valid room",
    ],
    ["no sender", message({ sender: undefined }), "message has no valid sender"],
    ["a sender without a name", message({ sender: { id: "u" } }), "message has no valid sender"],
    [
      "a hasMentions that is a string",
      message({ hasMentions: "yes" }),
      "message has an invalid hasMentions",
    ],
    ["mentions that are not a list", message({ mentions: {} }), "message has invalid mentions"],
    [
      "a mention that is not a user",
      message({ mentions: [{ id: "u" }] }),
      "message has invalid mentions",
    ],
    [
      "attachments that are not a list",
      message({ attachments: "a" }),
      "message has invalid attachments",
    ],
    [
      "an attachment without a type",
      message({ attachments: [{}] }),
      "message has invalid attachments",
    ],
    [
      "an attachment size that is a string",
      message({ attachments: [{ type: "file", size: "1" }] }),
      "message has invalid attachments",
    ],
    ["a quoted without text", message({ quoted: { id: "m" } }), "message has an invalid quoted"],
    [
      "a quoted whose sender is not a user",
      message({ quoted: { id: "m", text: "t", sender: 1 } }),
      "message has an invalid quoted",
    ],
    ["a raw that is a list", message({ raw: [] }), "message has an invalid raw"],
  ];
  for (const [title, value, problem] of broken) {
    it(`refuses ${title}`, () => {
      assert.equal(wireMessageProblem(value), problem);
      assert.equal(isWireMessage(value), false);
    });
  }

  it("narrows to a WireMessage", () => {
    const value: unknown = message();

    if (isWireMessage(value)) {
      const typed: WireMessage = value;
      assert.equal(typed.id, "m1");
    } else {
      assert.fail("expected a valid message");
    }
  });
});
