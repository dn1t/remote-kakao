import type { DeviceContext } from "../src/device.ts";
import { DeviceState, SessionState } from "../src/device.ts";
import type { AnyFrame, RequestFrame } from "../src/protocol.ts";
import type { OpenedFrame } from "../src/seal.ts";
import { deriveKey, Direction, openFrame, sealFrame } from "../src/seal.ts";
import type { Link, Transport } from "../src/types.ts";

/** Link that records what is written to it. `failNext` makes the next writes reject. */
export function fakeLink(): Link & { written: Uint8Array[]; failNext: Error[] } {
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

/** Makes a device whose context records the calls it gets. */
export function newDevice(options: { requestTimeout?: number } = {}) {
  let nextId = 1;
  const pendingChanges: number[] = [];
  const errors: unknown[] = [];
  const ctx: DeviceContext = {
    requestTimeout: options.requestTimeout ?? 30_000,
    nextRequestId: () => `r${nextId++}`,
    onPendingChange: (device) => pendingChanges.push(device.pendingCount),
    reportDeviceError: (_device, error) => errors.push(error),
  };
  const device = new DeviceState(
    { id: "phone", name: "Phone", platform: "ios", client: { name: "test", version: "1" } },
    ctx,
  );
  return { device, pendingChanges, errors };
}

/**
 * Plain session (no keys) over a fake link. `reliable: false` makes the core retransmit.
 * `sent()` returns the requests written to the link so far, and `frames()` all the frames.
 */
export function plainSession(reliable = true) {
  const link = { ...fakeLink(), reliable };
  const session = new SessionState({
    id: "s1",
    device: "phone",
    transport: "udp",
    link,
    keys: undefined,
    budget: undefined,
  });
  const sent = () =>
    link.written
      .map((bytes) => openFrame(bytes)?.frame)
      .filter((f) => f?.t === "req") as RequestFrame[];
  const frames = () => link.written.map((bytes) => openFrame(bytes)?.frame);
  return { session, link, sent, frames };
}

export const settled = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** Waits until the promises that can settle right now have run. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Link the test feeds frames to, as a device would. It records what is written and how it was closed. */
export interface ControlledLink extends Link {
  /** The device sends these bytes. */
  push(bytes: Uint8Array): void;
  /** The link ends normally. */
  end(): void;
  /** The link breaks. */
  fail(error: Error): void;
  /** What was written to the link, as bytes. */
  readonly written: Uint8Array[];
  /** The reasons the link was closed with, in order. */
  readonly closed: Array<string | undefined>;
}

export function controlledLink(reliable = true, remoteAddress = "10.0.0.2:5000"): ControlledLink {
  const queue: Array<{ bytes: Uint8Array } | { end: true } | { error: Error }> = [];
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const written: Uint8Array[] = [];
  const closed: Array<string | undefined> = [];

  async function* frames(): AsyncGenerator<Uint8Array> {
    while (true) {
      const item = queue.shift();
      if (item === undefined) {
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      if ("bytes" in item) yield item.bytes;
      else if ("error" in item) throw item.error;
      else return;
    }
  }

  return {
    remoteAddress,
    reliable,
    frames: frames(),
    written,
    closed,
    push(bytes) {
      queue.push({ bytes });
      notify();
    },
    end() {
      queue.push({ end: true });
      notify();
    },
    fail(error) {
      queue.push({ error });
      notify();
    },
    async send(frame) {
      written.push(frame);
    },
    close(reason) {
      closed.push(reason);
      queue.push({ end: true });
      notify();
    },
  };
}

/** Transport that hands out the links the test connects. */
export function fakeTransport(name = "fake") {
  let accept: ((link: Link) => void) | undefined;
  const state = { listening: false, closed: false };
  const transport: Transport = {
    name,
    async listen(callback) {
      accept = callback;
      state.listening = true;
      return {
        address: `${name}://test`,
        async close() {
          state.closed = true;
        },
      };
    },
  };
  return {
    transport,
    state,
    /** A device connects over a new link. */
    connect(link = controlledLink()): ControlledLink {
      if (accept === undefined) throw new Error("the transport is not listening");
      accept(link);
      return link;
    },
  };
}

const CLIENT_SALT = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

/** The device side of a session: seals what the device sends and opens what Node sends back. */
export function fakeClient(
  options: {
    /** `undefined` for plain frames, as with `auth: false`. */
    token?: string | undefined;
    device?: string;
    salt?: Uint8Array;
  } = {},
) {
  const token = "token" in options ? options.token : "secret";
  const device = options.device ?? "phone";
  const salt = options.salt ?? CLIENT_SALT;
  const up = token === undefined ? undefined : deriveKey(token, salt, Direction.Up);
  const down = token === undefined ? undefined : deriveKey(token, salt, Direction.Down);
  let counter = 0n;

  return {
    device,
    salt,
    /** A frame as the device sends it, with the next counter. */
    seal(frame: AnyFrame, withCounter = counter++): Uint8Array {
      return sealFrame(
        frame,
        up === undefined
          ? { direction: Direction.Up, device }
          : { direction: Direction.Up, device, salt, counter: withCounter, key: up },
      );
    },
    /** A hello that passes every check, unless `overrides` says otherwise. */
    hello(overrides: Record<string, unknown> = {}): Uint8Array {
      return this.seal({
        t: "hello",
        v: 1,
        ts: Date.now(),
        device: { id: device, name: "Phone", platform: "ios" },
        client: { name: "test", version: "1" },
        caps: ["room.send"],
        appInstances: [{ id: "kakao", me: { id: "u1", name: "Ann" } }],
        ...overrides,
      } as AnyFrame);
    },
    /** An event frame carrying a message, as the device sends it. */
    messageEvent(
      id: string,
      overrides: { message?: Record<string, unknown>; frame?: Record<string, unknown> } = {},
    ): Uint8Array {
      return this.seal({
        t: "event",
        id,
        name: "message",
        appInstance: "kakao",
        data: {
          id: `m-${id}`,
          room: { id: "r1", name: "Team" },
          sender: { id: "u2", name: "Bob" },
          type: "text",
          text: "hello",
          time: 1_700_000_000_000,
          ...overrides.message,
        },
        ...overrides.frame,
      } as AnyFrame);
    },
    /** The frames Node wrote, as the device reads them. */
    received(link: { written: Uint8Array[] }): Array<OpenedFrame | undefined> {
      return link.written.map((bytes) => openFrame(bytes, down));
    },
  };
}
