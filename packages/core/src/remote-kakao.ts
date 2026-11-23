import { randomUUID } from "node:crypto";

import { decodeRef } from "./convert.ts";
import type { DeviceContext } from "./device.ts";
import { DeviceState } from "./device.ts";
import { Emitter } from "./emitter.ts";
import type { MessageStream } from "./entities.ts";
import { AppInstanceImpl } from "./entities.ts";
import { createErrorReporter } from "./error-report.ts";
import type { ResolvedOptions } from "./options.ts";
import { resolveOptions } from "./options.ts";
import type { AppInstanceId, DeviceId } from "./protocol.ts";
import type {
  Device,
  ErrorReport,
  EventName,
  EventPayload,
  IterateOptions,
  Listener,
  ListenerOptions,
  RemoteKakaoOptions,
  Room,
  Unsubscribe,
  WaitOptions,
} from "./types.ts";

/**
 * The main class of remote-kakao: a server that devices running a KakaoTalk client connect to.
 *
 * It reports what happens on the devices as events, such as `message`.
 * It also gives access to their app instances and rooms, so that your code can send messages
 * and make other requests to them.
 * Devices connect over the transports given in the options.
 */
export class RemoteKakao {
  readonly #options: ResolvedOptions;
  readonly #emitter: Emitter;
  readonly #reportError: (report: ErrorReport) => void;
  readonly #devices = new Map<DeviceId, DeviceState>();
  /** What rooms read messages through. */
  readonly #messages: MessageStream;
  /** What the devices need from this object. */
  readonly #deviceContext: DeviceContext;
  /** Tells this run apart from earlier ones, so request ids stay unique across restarts. */
  readonly #bootId = randomUUID();
  #requestCounter = 0;

  /** Throws if the options are invalid. */
  constructor(options: RemoteKakaoOptions) {
    this.#options = resolveOptions(options);
    const { logger } = this.#options;
    this.#emitter = new Emitter({
      onListenerError: (error, event) =>
        this.#reportError({ error, source: "listener", event, device: undefined }),
      onDrop: (event, dropped) => logger.warn(`dropped ${dropped} buffered "${event}" payload(s)`),
    });
    this.#reportError = createErrorReporter(this.#emitter, logger);

    this.#messages = {
      wait: (options) => this.#emitter.wait("message", options),
      iterate: (options) => this.#emitter.iterate("message", options),
    };
    this.#deviceContext = {
      requestTimeout: this.#options.requestTimeout,
      nextRequestId: () => `${this.#bootId}-${++this.#requestCounter}`,
      onPendingChange: (device) => {
        if (device.session !== undefined && device.pendingCount > 0) {
          device.session.idleNotified = false;
        }
        this.#maybeIdle(device);
      },
      reportDeviceError: (device, error) =>
        this.#reportError({ error, source: "device", event: undefined, device }),
    };
  }

  /** Every device that has connected, by id. A device stays after it disconnects. */
  get devices(): ReadonlyMap<DeviceId, Device> {
    return this.#devices;
  }

  /** Calls `listener` every time the event happens. */
  on<E extends EventName>(event: E, listener: Listener<E>, options?: ListenerOptions): Unsubscribe {
    return this.#emitter.on(event, listener, options);
  }

  /** Calls `listener` the next time the event happens, and then removes it. */
  once<E extends EventName>(
    event: E,
    listener: Listener<E>,
    options?: ListenerOptions,
  ): Unsubscribe {
    return this.#emitter.once(event, listener, options);
  }

  /** Resolves with the next payload of the event that passes `options.filter`. */
  wait<E extends EventName>(
    event: E,
    options?: WaitOptions<EventPayload<E>>,
  ): Promise<EventPayload<E>> {
    return this.#emitter.wait(event, options);
  }

  /** Iterates over the payloads of the event as they come, with `for await`. */
  iterate<E extends EventName>(
    event: E,
    options?: IterateOptions<EventPayload<E>>,
  ): AsyncIterableIterator<EventPayload<E>> {
    return this.#emitter.iterate(event, options);
  }

  /**
   * The room with the given `ref`, which `room.ref` gives. Does not ask the device.
   * The device may never have connected. Its capabilities are unknown then, so calls are let through.
   * Throws a `TypeError` if `ref` is not one that `room.ref` gave.
   */
  room(ref: string): Room {
    const location = decodeRef(ref);
    if (location === undefined) throw new TypeError("not a valid room ref");
    const device = this.#ensureDevice(location.device);
    return this.#ensureAppInstance(device, location.appInstance).room(location.room);
  }

  /** The device with the id. A device that has not connected yet gets placeholder details. */
  #ensureDevice(id: DeviceId): DeviceState {
    let device = this.#devices.get(id);
    if (device === undefined) {
      device = new DeviceState(
        { id, name: id, platform: "unknown", client: { name: "unknown", version: "0" } },
        this.#deviceContext,
      );
      this.#devices.set(id, device);
    }
    return device;
  }

  #ensureAppInstance(device: DeviceState, id: AppInstanceId): AppInstanceImpl {
    let appInstance = device.appInstance(id);
    if (appInstance === undefined) {
      appInstance = new AppInstanceImpl(device, id, this.#messages);
      device.appInstances = [...device.appInstances, appInstance];
    }
    return appInstance;
  }

  /**
   * Tells the client it can end the session, once nothing is left to do for it:
   * no request waits for an answer and no listener is still running.
   * It is a hint, so a failure to send it is not reported.
   */
  #maybeIdle(device: DeviceState): void {
    const session = device.session;
    if (session === undefined || session.ended || session.idleNotified) return;
    if (device.pendingCount > 0 || session.openDispatches > 0) return;
    session.idleNotified = true;
    session.send({ t: "idle" }).catch(() => {});
  }
}
