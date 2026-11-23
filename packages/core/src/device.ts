import { RKError } from "./errors.ts";
import type { DeviceId, ServerFrame } from "./protocol.ts";
import { ReplayWindow } from "./replay-window.ts";
import { Direction, sealFrame } from "./seal.ts";
import type { DeviceSession, Link } from "./types.ts";

/** Keys and salt of a sealed session. Plain sessions (`auth: false`) have none. */
export interface SessionKeys {
  /** The salt the client chose for the session. */
  salt: Uint8Array;
  /** Key of the frames from the device to Node. */
  up: Uint8Array;
  /** Key of the frames from Node to the device. */
  down: Uint8Array;
}

export interface SessionParams {
  id: string;
  device: DeviceId;
  transport: string;
  link: Link;
  /** `undefined` for a plain session (`auth: false`). */
  keys: SessionKeys | undefined;
  /** Ms the session can last, from the `hello`. */
  budget: number | undefined;
}

/** A `ping` waiting for its `pong`. */
interface PingWaiter {
  resolve(): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One session with a device, over one link. */
export class SessionState implements DeviceSession {
  readonly id: string;
  readonly device: DeviceId;
  readonly transport: string;
  readonly link: Link;
  readonly keys: SessionKeys | undefined;
  readonly startedAt = new Date();
  readonly expiresAt: Date | undefined;
  /** `true` once the session is over. */
  ended = false;
  /** Listeners of this session's events that are still running. */
  openDispatches = 0;
  /** Whether `idle` was sent since the last activity, so it is not sent twice. */
  idleNotified = false;

  /** Counter of the next frame sent. */
  #sendCounter = 0n;
  readonly #replayWindow = new ReplayWindow();
  /** In the order the pings were sent: a `pong` answers the oldest. */
  readonly #pingWaiters: PingWaiter[] = [];

  constructor(params: SessionParams) {
    this.id = params.id;
    this.device = params.device;
    this.transport = params.transport;
    this.link = params.link;
    this.keys = params.keys;
    this.expiresAt =
      params.budget === undefined ? undefined : new Date(this.startedAt.getTime() + params.budget);
  }

  get remoteAddress(): string {
    return this.link.remoteAddress;
  }

  /** Whether the counter of a frame from the device is new. Sealed sessions only. */
  acceptCounter(counter: bigint): boolean {
    return this.#replayWindow.accept(counter);
  }

  /** Seals the frame with the next counter and writes it to the link. */
  async send(frame: ServerFrame): Promise<void> {
    const counter = this.#sendCounter++;
    const bytes = sealFrame(
      frame,
      this.keys === undefined
        ? { direction: Direction.Down, device: this.device }
        : {
            direction: Direction.Down,
            device: this.device,
            salt: this.keys.salt,
            counter,
            key: this.keys.down,
          },
    );
    await this.link.send(bytes);
  }

  /**
   * Sends a `ping` and waits for the `pong`. Rejects with `TIMEOUT` after `timeout` ms,
   * with the error of the link if the frame can't be sent, or with `DEVICE_OFFLINE` if the session ends first.
   */
  ping(timeout: number): Promise<void> {
    if (this.ended) return Promise.reject(sessionEnded());
    return new Promise<void>((resolve, reject) => {
      const waiter: PingWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#removeWaiter(waiter);
          reject(new RKError("TIMEOUT", "ping timed out"));
        }, timeout),
      };
      this.#pingWaiters.push(waiter);
      this.send({ t: "ping" }).catch((error: unknown) => {
        if (this.#removeWaiter(waiter)) reject(error);
      });
    });
  }

  /** Answers the oldest `ping` still waiting. Does nothing if there is none. */
  resolvePing(): void {
    const waiter = this.#pingWaiters[0];
    if (waiter === undefined) return;
    this.#removeWaiter(waiter);
    waiter.resolve();
  }

  /** Marks the session as over and rejects the pings still waiting. Does not close the link. */
  end(): void {
    this.ended = true;
    for (const waiter of this.#pingWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(sessionEnded());
    }
  }

  /** Returns whether the waiter was still waiting. */
  #removeWaiter(waiter: PingWaiter): boolean {
    const index = this.#pingWaiters.indexOf(waiter);
    if (index < 0) return false;
    this.#pingWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    return true;
  }
}

function sessionEnded(): RKError {
  return new RKError("DEVICE_OFFLINE", "the session ended");
}
