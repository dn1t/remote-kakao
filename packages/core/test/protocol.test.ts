// `@ts-expect-error` lines are verified by `tsc -p test`

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ClientErrorCode,
  ClientFrame,
  EventFrame,
  WireEventName,
  Hello,
  WireMethodName,
  Ping,
  ResponseFrame,
  ServerFrame,
  Welcome,
  WireMessage,
} from "../src/protocol.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

/** Returns `value` typed as `T`, so a wrong type is a compile error at the call site. */
function accept<T>(value: T): T {
  return value;
}

function assertNever(value: never): never {
  throw new Error(`unhandled frame: ${JSON.stringify(value)}`);
}

const message: WireMessage = {
  id: "m1",
  room: { id: "r1" },
  sender: { id: "u1", name: "Alice" },
  type: "text",
  text: "hello",
  time: 0,
};

const hello: Hello = {
  t: "hello",
  v: PROTOCOL_VERSION,
  ts: 0,
  device: { id: "phone", name: "Phone", platform: "ios" },
  client: { name: "test", version: "0.0.0" },
  caps: [],
  accounts: [],
};

const welcome: Welcome = { t: "welcome", v: PROTOCOL_VERSION, session: "s1" };

describe("PROTOCOL_VERSION", () => {
  it("is 1", () => {
    assert.equal(PROTOCOL_VERSION, 1);
  });
});

describe("EventFrame", () => {
  function textOf(frame: EventFrame): string {
    if (frame.name === "message") {
      // Inside this check, `frame.data` is narrowed from `unknown` to `WireMessage`.
      assert.equal(accept<WireMessage>(frame.data), frame.data);
      // @ts-expect-error a message event does not carry a string
      accept<string>(frame.data);
      return frame.data.text;
    }
    // @ts-expect-error extension events carry `unknown`, not a message
    accept<WireMessage>(frame.data);
    return String(accept<unknown>(frame.data));
  }

  it("narrows data by the name of a built-in event", () => {
    assert.equal(textOf({ t: "event", id: "boot-1", name: "message", data: message }), "hello");
  });

  it("carries unknown data for extension events", () => {
    assert.equal(textOf({ t: "event", id: "boot-2", name: "kakaolink:clicked", data: 42 }), "42");
  });

  it("rejects data that does not match a built-in event", () => {
    // @ts-expect-error a message event must carry a WireMessage
    const frame: EventFrame = { t: "event", id: "boot-3", name: "message", data: "hello" };

    assert.equal(frame.name, "message");
  });

  it("rejects a name that is neither built-in nor namespaced", () => {
    // @ts-expect-error extension events need `namespace:name`
    const frame: EventFrame = { t: "event", id: "boot-4", name: "unknown", data: 1 };

    assert.equal(frame.name, "unknown");
  });
});

describe("frame unions", () => {
  function clientFrameType(frame: ClientFrame): ClientFrame["t"] {
    switch (frame.t) {
      case "hello":
      case "event":
      case "req":
      case "res":
      case "ping":
      case "pong":
      case "bye":
        return frame.t;
      default:
        return assertNever(frame);
    }
  }

  function serverFrameType(frame: ServerFrame): ServerFrame["t"] {
    switch (frame.t) {
      case "welcome":
      case "reject":
      case "ack":
      case "req":
      case "res":
      case "idle":
      case "ping":
      case "pong":
      case "bye":
        return frame.t;
      default:
        return assertNever(frame);
    }
  }

  it("covers every client frame exactly once", () => {
    assert.equal(clientFrameType(hello), "hello");
    assert.equal(clientFrameType({ t: "ping" }), "ping");
  });

  it("covers every server frame exactly once", () => {
    assert.equal(serverFrameType(welcome), "welcome");
    assert.equal(serverFrameType({ t: "idle" }), "idle");
  });

  it("keeps each direction to its own frames", () => {
    assert.equal(accept<ClientFrame>(hello).t, "hello");
    assert.equal(accept<ServerFrame>(welcome).t, "welcome");
    // @ts-expect-error `welcome` only flows from Node to the client
    accept<ClientFrame>(welcome);
    // @ts-expect-error `hello` only flows from the client to Node
    accept<ServerFrame>(hello);
  });

  it("lets both sides send ping, pong, bye, req and res", () => {
    const ping: Ping = { t: "ping" };

    assert.equal(accept<ClientFrame>(ping).t, accept<ServerFrame>(ping).t);
    assert.equal(accept<ClientFrame>({ t: "bye" }).t, accept<ServerFrame>({ t: "bye" }).t);
  });
});

describe("ResponseFrame", () => {
  function outcome(response: ResponseFrame): string {
    if (response.ok) {
      // @ts-expect-error a successful response has no error
      accept(response.error);
      return String(accept<unknown>(response.result));
    }
    return accept<ClientErrorCode>(response.error.code);
  }

  it("narrows to the result when ok", () => {
    assert.equal(outcome({ t: "res", id: "q1", ok: true, result: "done" }), "done");
  });

  it("narrows to the error when not ok", () => {
    const error = { code: "NOT_FOUND", message: "no such room" } as const;

    assert.equal(outcome({ t: "res", id: "q2", ok: false, error }), "NOT_FOUND");
  });

  it("only allows client error codes", () => {
    // @ts-expect-error `TIMEOUT` is raised by Node, never reported by a client
    const error: { code: ClientErrorCode; message: string } = { code: "TIMEOUT", message: "x" };

    assert.equal(error.code, "TIMEOUT");
  });
});

describe("method and event names", () => {
  it("accept built-in and namespaced names only", () => {
    assert.equal(accept<WireMethodName>("room.send"), "room.send");
    assert.equal(accept<WireMethodName>("kakaolink:send"), "kakaolink:send");
    assert.equal(accept<WireEventName>("message"), "message");
    assert.equal(accept<WireEventName>("kakaolink:clicked"), "kakaolink:clicked");
    // @ts-expect-error neither a built-in method nor namespaced
    accept<WireMethodName>("room.unknown");
    // @ts-expect-error neither a built-in event nor namespaced
    accept<WireEventName>("messages");
  });
});
