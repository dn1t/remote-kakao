import type { DeviceContext } from "../src/device.ts";
import { DeviceState, SessionState } from "../src/device.ts";
import type { RequestFrame } from "../src/protocol.ts";
import { openFrame } from "../src/seal.ts";
import type { Link } from "../src/types.ts";

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
