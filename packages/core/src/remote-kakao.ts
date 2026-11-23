import type { DeviceState } from "./device.ts";
import { Emitter } from "./emitter.ts";
import { createErrorReporter } from "./error-report.ts";
import type { ResolvedOptions } from "./options.ts";
import { resolveOptions } from "./options.ts";
import type { DeviceId } from "./protocol.ts";
import type {
  Device,
  ErrorReport,
  EventName,
  EventPayload,
  IterateOptions,
  Listener,
  ListenerOptions,
  RemoteKakaoOptions,
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
}
