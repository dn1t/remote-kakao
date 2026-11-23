import { RKError } from "./errors.ts";
import type {
  AppInstanceId,
  Capability,
  ClientErrorCode,
  DeviceId,
  EventId,
  Methods,
  Platform,
  RequestFrame,
  RequestId,
  ResponseFrame,
  RoomId,
  ServerFrame,
  WireMethodName,
} from "./protocol.ts";
import { ReplayWindow } from "./replay-window.ts";
import { Direction, sealFrame } from "./seal.ts";
import type {
  AppInstance,
  Device,
  DeviceSession,
  ExtensionMethodName,
  ExtensionParams,
  ExtensionResult,
  Link,
  RequestOptions,
} from "./types.ts";

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
  /** Ms the session can last, as declared in the `hello`. `undefined` for a client that stays connected. */
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

/** Errors a client can answer a request with. Any other code is read as `CLIENT_ERROR`. */
const CLIENT_ERROR_CODES: ReadonlySet<string> = new Set<ClientErrorCode>([
  "UNSUPPORTED",
  "NOT_FOUND",
  "UNREACHABLE",
  "REJECTED",
  "CLIENT_ERROR",
]);

/**
 * Retransmission on links that lose frames.
 * The first retry comes after 2 s, each next one twice as late, and there are at most 4.
 */
const RETRANSMIT_BASE = 2000;
const RETRANSMIT_MAX = 4;

/** How many event ids a device remembers to drop events that arrive twice. */
export const MAX_SEEN_EVENTS = 4096;

/** The longest delay `setTimeout` accepts. A longer one is cut to 1 ms. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/** Services the `RemoteKakao` provides to the devices it owns. */
export interface DeviceContext {
  /** Default deadline in ms for requests that don't set their own `timeout`. */
  readonly requestTimeout: number;
  nextRequestId(): RequestId;
  /** A request was added or settled, so whether the device is idle may have changed. */
  onPendingChange(device: DeviceState): void;
  /** Reports an error that has no call to be thrown from. */
  reportDeviceError(device: DeviceState, error: unknown): void;
}

/** Description of a device, from its `hello`. */
export interface DeviceInit {
  id: DeviceId;
  name: string;
  platform: Platform;
  client: { name: string; version: string };
}

/** A request in flight: the frame to send, its deadline and timers, and how to settle the caller's promise. */
interface RequestRecord {
  frame: RequestFrame;
  /** When the request gives up, in epoch ms. */
  deadlineAt: number;
  resolve(value: unknown): void;
  reject(error: RKError): void;
  settled: boolean;
  /** Whether it was ever written to a session. Tells a timeout from "no session". */
  everSent: boolean;
  deadlineTimer: ReturnType<typeof setTimeout>;
  retransmitTimer: ReturnType<typeof setTimeout> | undefined;
  /** Retransmissions in the current session. */
  retransmits: number;
  /** Stops the timers and the abort listener. */
  cleanup(): void;
}

/**
 * A device, which stays the same object across its sessions.
 * Keeps what the device reported in its `hello`, and the requests sent to it.
 * A request made while the device has no session waits for the next one.
 */
export class DeviceState implements Device {
  readonly id: DeviceId;
  name: string;
  platform: Platform;
  client: { readonly name: string; readonly version: string };
  /** Protocol version from the latest handshake. `0` before the first. */
  protocolVersion = 0;
  readonly capabilities = new Set<Capability>();
  /** App instances from the latest handshake. */
  appInstances: readonly AppInstance[] = [];
  /** The open session, if any. */
  session: SessionState | undefined;
  /** When a session with the device last started or ended. */
  lastSeenAt: Date | undefined;

  readonly #ctx: DeviceContext;
  /** Requests written to the current session and not answered yet. */
  readonly #pending = new Map<RequestId, RequestRecord>();
  /** Requests with no session to be written to. */
  readonly #queue: RequestRecord[] = [];
  /** For each room with sends in progress, the promise of its last send. */
  readonly #roomTails = new Map<string, Promise<void>>();
  /** Ids of the latest events, oldest first. */
  readonly #seenEvents = new Set<EventId>();

  constructor(init: DeviceInit, ctx: DeviceContext) {
    this.id = init.id;
    this.name = init.name;
    this.platform = init.platform;
    this.client = init.client;
    this.#ctx = ctx;
  }

  get status(): "online" | "offline" {
    return this.session !== undefined && !this.session.ended ? "online" : "offline";
  }

  /** Requests waiting for an answer or for a session. */
  get pendingCount(): number {
    return this.#pending.size + this.#queue.length;
  }

  supports(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  appInstance(id: AppInstanceId): AppInstance | undefined {
    return this.appInstances.find((appInstance) => appInstance.id === id);
  }

  /**
   * Makes the session the current one and writes the queued requests to it.
   * The requests left unanswered by the previous session are written again.
   */
  attachSession(session: SessionState): void {
    if (this.session !== undefined && this.session !== session) this.detachSession(this.session);
    this.session = session;
    this.lastSeenAt = new Date();
    for (const record of this.#queue.splice(0)) this.#dispatch(record, session);
  }

  /**
   * Ends the session. Requests it left unanswered wait for the next one until their deadline.
   * If a newer session has already replaced it, only ends it and leaves the current one alone.
   */
  detachSession(session: SessionState): void {
    session.end();
    if (this.session !== session) return;
    this.session = undefined;
    this.lastSeenAt = new Date();
    for (const record of this.#pending.values()) {
      clearTimeout(record.retransmitTimer);
      record.retransmits = 0;
      this.#queue.push(record);
    }
    this.#pending.clear();
  }

  /** Pings the device and returns the round-trip time in ms. */
  async ping(options?: RequestOptions): Promise<number> {
    const session = this.session;
    if (session === undefined || session.ended) {
      throw new RKError("DEVICE_OFFLINE", "no open session", { device: this });
    }
    const timeout = options?.timeout ?? this.#ctx.requestTimeout;
    const error = timeoutError(timeout);
    if (error) throw error;
    const start = performance.now();
    try {
      await session.ping(timeout);
    } catch (error) {
      if (error instanceof RKError)
        throw new RKError(error.code, error.message, { cause: error, device: this });
      throw error;
    }
    return Math.round(performance.now() - start);
  }

  /** Calls a method registered by a client-side extension. */
  call<M extends ExtensionMethodName>(
    method: M,
    params: ExtensionParams<M>,
    options?: RequestOptions,
  ): Promise<ExtensionResult<M>> {
    return this.extensionRequest(method, params, options) as Promise<ExtensionResult<M>>;
  }

  /** Says goodbye to the device and closes the link. Does nothing without a session. */
  disconnect(reason?: string): void {
    const session = this.session;
    if (session === undefined || session.ended) return;
    const frame: ServerFrame = reason === undefined ? { t: "bye" } : { t: "bye", reason };
    session
      .send(frame)
      .catch(() => {})
      .then(() => session.link.close(reason));
  }

  /** Sends a built-in method to the device. */
  request<M extends keyof Methods>(
    method: M,
    params: Methods[M]["params"],
    options?: RequestOptions,
  ): Promise<Methods[M]["result"]> {
    return this.#request(method, params, options) as Promise<Methods[M]["result"]>;
  }

  /** Sends an extension method to the device. */
  extensionRequest(
    method: `${string}:${string}`,
    params: unknown,
    options?: RequestOptions,
  ): Promise<unknown> {
    return this.#request(method, params, options);
  }

  #request(method: WireMethodName, params: unknown, options?: RequestOptions): Promise<unknown> {
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new RKError("ABORTED", "request aborted", { cause: signal.reason, device: this }),
      );
    }
    const timeout = options?.timeout ?? this.#ctx.requestTimeout;
    const invalid = timeoutError(timeout);
    if (invalid) return Promise.reject(invalid);
    const id = this.#ctx.nextRequestId();

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () =>
        this.#settle(record, () =>
          reject(
            new RKError("ABORTED", "request aborted", { cause: signal?.reason, device: this }),
          ),
        );
      const record: RequestRecord = {
        frame: { t: "req", id, method, params, ttl: timeout },
        deadlineAt: Date.now() + timeout,
        resolve,
        reject,
        settled: false,
        everSent: false,
        retransmits: 0,
        deadlineTimer: setTimeout(() => {
          const message = record.everSent ? "timed out" : "found no session";
          const code = record.everSent ? "TIMEOUT" : "DEVICE_OFFLINE";
          this.#settle(record, () =>
            reject(new RKError(code, `request "${method}" ${message}`, { device: this })),
          );
        }, timeout),
        retransmitTimer: undefined,
        cleanup: () => {
          clearTimeout(record.deadlineTimer);
          clearTimeout(record.retransmitTimer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      if (this.session !== undefined && !this.session.ended) this.#dispatch(record, this.session);
      else this.#queue.push(record);
      this.#ctx.onPendingChange(this);
    });
  }

  /** Writes the request to the session, and keeps writing it if the link loses frames. */
  #dispatch(record: RequestRecord, session: SessionState): void {
    record.everSent = true;
    this.#pending.set(record.frame.id, record);
    this.#write(record, session).catch((error: unknown) => {
      this.#ctx.reportDeviceError(this, error);
    });
    if (!session.link.reliable) this.#scheduleRetransmit(record, session);
    this.#ctx.onPendingChange(this);
  }

  /** Writes the request with the time left to its deadline as `ttl`, so the device knows when to give up. */
  #write(record: RequestRecord, session: SessionState): Promise<void> {
    record.frame = { ...record.frame, ttl: Math.max(0, record.deadlineAt - Date.now()) };
    return session.send(record.frame);
  }

  #scheduleRetransmit(record: RequestRecord, session: SessionState): void {
    if (record.retransmits >= RETRANSMIT_MAX) return;
    const delay = RETRANSMIT_BASE * 2 ** record.retransmits;
    if (Date.now() + delay >= record.deadlineAt) return;
    record.retransmitTimer = setTimeout(() => {
      if (record.settled || this.session !== session) return;
      record.retransmits += 1;
      this.#write(record, session).catch(() => {});
      this.#scheduleRetransmit(record, session);
    }, delay);
  }

  /** Settles the request the response answers. A response to a request that is not waiting is ignored. */
  handleResponse(frame: ResponseFrame): void {
    const record = this.#pending.get(frame.id);
    if (record === undefined) return;
    if (frame.ok) {
      this.#settle(record, () => record.resolve(frame.result));
      return;
    }
    const { code, message } = frame.error;
    this.#settle(record, () =>
      record.reject(
        new RKError(
          CLIENT_ERROR_CODES.has(code) ? code : "CLIENT_ERROR",
          typeof message === "string" ? message : "client error",
          { device: this },
        ),
      ),
    );
  }

  /** Rejects every request, answered or not. */
  rejectAll(error: RKError): void {
    for (const record of [...this.#pending.values(), ...this.#queue]) {
      this.#settle(record, () => record.reject(error));
    }
  }

  /**
   * Makes sends to the same room run one at a time, in the order `chainRoomSend` was called.
   * `run` starts when the previous send has settled, even if it failed.
   * The caller doesn't need to await the previous send to keep the order.
   */
  chainRoomSend<T>(appInstance: AppInstanceId, room: RoomId, run: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([appInstance, room]);
    const result = (this.#roomTails.get(key) ?? Promise.resolve()).then(run);
    const tail: Promise<void> = result
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        if (this.#roomTails.get(key) === tail) this.#roomTails.delete(key);
      });
    this.#roomTails.set(key, tail);
    return result;
  }

  /**
   * Whether the event is new. A client resends an event until it is acked, so the same id can arrive more than once.
   * The ids of the last `MAX_SEEN_EVENTS` events are kept.
   */
  acceptEvent(id: EventId): boolean {
    if (this.#seenEvents.has(id)) return false;
    this.#seenEvents.add(id);
    if (this.#seenEvents.size > MAX_SEEN_EVENTS) {
      this.#seenEvents.delete(this.#seenEvents.values().next().value!);
    }
    return true;
  }

  #settle(record: RequestRecord, run: () => void): void {
    if (record.settled) return;
    record.settled = true;
    record.cleanup();
    this.#pending.delete(record.frame.id);
    const index = this.#queue.indexOf(record);
    if (index >= 0) this.#queue.splice(index, 1);
    run();
    this.#ctx.onPendingChange(this);
  }
}

function timeoutError(timeout: number): RangeError | undefined {
  if (timeout >= 0 && timeout <= MAX_TIMEOUT) return undefined;
  return new RangeError(`timeout must be between 0 and ${MAX_TIMEOUT} ms, got ${timeout}`);
}
