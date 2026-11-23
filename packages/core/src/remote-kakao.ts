import { randomUUID } from "node:crypto";

import { decodeRef } from "./convert.ts";
import type { DeviceContext, SessionKeys } from "./device.ts";
import { DeviceState, SessionState, timeoutError } from "./device.ts";
import { Emitter } from "./emitter.ts";
import type { MessageStream } from "./entities.ts";
import { AppInstanceImpl, MessageImpl, UserImpl } from "./entities.ts";
import { createErrorReporter } from "./error-report.ts";
import { RKError } from "./errors.ts";
import { checkHello, SALT_TTL } from "./hello.ts";
import type { IncomingFrame, TokenLookup } from "./intake.ts";
import { intake } from "./intake.ts";
import type { ResolvedOptions } from "./options.ts";
import { resolveOptions } from "./options.ts";
import type {
  AppInstanceId,
  ClientFrame,
  DeviceId,
  EventFrame,
  Hello,
  Reject,
  ServerFrame,
  WireMessage,
} from "./protocol.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { SaltCache } from "./salt-cache.ts";
import { Direction, sealFrame } from "./seal.ts";
import type {
  Device,
  ErrorReport,
  EventName,
  EventPayload,
  ExtensionEvent,
  IterateOptions,
  Link,
  Listener,
  ListenerOptions,
  Plugin,
  RemoteKakaoOptions,
  Room,
  Transport,
  TransportHandle,
  Unsubscribe,
  WaitOptions,
} from "./types.ts";
import { wireMessageProblem } from "./wire-message.ts";

/** What a link holds once its device has said hello. */
interface Connection {
  device: DeviceState;
  session: SessionState;
  /** Tells that a frame arrived, which keeps a session without a budget from timing out. */
  touch(): void;
}

/** How long, in ms, a link may stay open without a hello that starts a session. */
const HELLO_TIMEOUT = 15_000;

/**
 * The main class of remote-kakao: a server that devices running a KakaoTalk client connect to.
 *
 * It reports what happens on the devices as events, such as `message`.
 * It also gives access to their app instances and rooms, so that your code can send messages
 * and make other requests to them.
 * Devices connect over the transports given in the options.
 */
export class RemoteKakao implements AsyncDisposable {
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
  /** `undefined` when `auth` is off. */
  readonly #tokenOf: TokenLookup | undefined;
  readonly #saltCache = new SaltCache(SALT_TTL);
  readonly #handles: TransportHandle[] = [];
  /** Links that are open. */
  readonly #links = new Set<Link>();
  /** The reading of each open link, which ends with the link. */
  readonly #readers = new Set<Promise<void>>();
  #listening = false;
  #closing: Promise<void> | undefined;
  readonly #plugins: Plugin[] = [];
  /** The plugins whose setup has started and not been undone. */
  readonly #started = new Set<Plugin>();
  /** What the plugins returned from `setup`, in the order they finished. */
  readonly #cleanups: Array<() => void | Promise<void>> = [];

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

    const { auth } = this.#options;
    this.#tokenOf =
      auth === false
        ? undefined
        : async (device) => (typeof auth.token === "function" ? auth.token(device) : auth.token);

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

  /**
   * Starts every transport, so that devices can connect.
   * If a transport fails to start, the ones started before it are stopped, and this rejects.
   * Does nothing if it is already listening.
   */
  async listen(options?: { signal?: AbortSignal }): Promise<void> {
    if (this.#closing !== undefined) throw new RKError("CLOSED", "RemoteKakao is closed");
    if (this.#listening) return;
    options?.signal?.throwIfAborted();
    this.#listening = true;

    const opened: TransportHandle[] = [];
    try {
      for (const plugin of this.#plugins) await this.#runPlugin(plugin);
      for (const transport of this.#options.transports) {
        const handle = await transport.listen((link) => this.#accept(transport, link));
        opened.push(handle);
        this.#options.logger.info(`listening on ${handle.address}`);
      }
    } catch (error) {
      await Promise.allSettled(opened.map((handle) => handle.close()));
      await this.#cleanUpPlugins();
      this.#listening = false;
      throw error;
    }
    this.#handles.push(...opened);
    options?.signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  /**
   * Adds a plugin, whose `setup` runs when `listen` starts, or now if it already did.
   * A plugin that was added before is ignored.
   * If `setup` fails, `listen` rejects with the error when the plugin was added before `listen`.
   * When it was added after `listen`, there is no call to reject, so the error is reported as an `error` event.
   * Throws a `TypeError` if `plugin` has no `name` and `setup`, and `CLOSED` after `close`.
   */
  use(plugin: Plugin): this {
    if (typeof plugin?.name !== "string" || typeof plugin.setup !== "function") {
      throw new TypeError("a plugin needs a `name` and a `setup` function");
    }
    if (this.#closing !== undefined) throw new RKError("CLOSED", "RemoteKakao is closed");
    if (this.#plugins.includes(plugin)) return this;
    this.#plugins.push(plugin);
    if (this.#listening) {
      this.#runPlugin(plugin).catch((error: unknown) =>
        this.#reportError({ error, source: "plugin", event: undefined, device: undefined }),
      );
    }
    return this;
  }

  /**
   * Stops listening and ends every session. Does nothing if it was already called.
   *
   * Devices are told goodbye, and their pending requests are rejected with `CLOSED`.
   * Listeners that are still running get `timeout` ms (default: `requestTimeout`) to finish.
   * Afterwards the events are closed: `wait` rejects with `CLOSED` and no listener is called.
   */
  close(options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? this.#options.requestTimeout;
    const invalid = timeoutError(timeout, "timeout");
    if (invalid) return Promise.reject(invalid);
    this.#closing ??= this.#shutDown(timeout);
    return this.#closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #shutDown(timeout: number): Promise<void> {
    await Promise.allSettled(this.#handles.map((handle) => handle.close()));
    // A device is told goodbye first. The other links have no session to end.
    const sessionLinks = new Set<Link>();
    for (const device of this.#devices.values()) {
      if (device.session !== undefined) sessionLinks.add(device.session.link);
      device.disconnect("server closing");
    }
    for (const link of this.#links) {
      if (!sessionLinks.has(link)) link.close("closed");
    }
    // Once the links have ended, `deviceDisconnect` has been emitted for every session.
    await within(timeout, Promise.allSettled(this.#readers));
    for (const link of this.#links) link.close("closed");

    const closed = new RKError("CLOSED", "RemoteKakao is closed");
    for (const device of this.#devices.values()) device.rejectAll(closed);
    await within(timeout, this.#emitter.settle());
    await this.#cleanUpPlugins();
    this.#emitter.close();
  }

  /** Runs the `setup` of the plugin, unless it already started. */
  async #runPlugin(plugin: Plugin): Promise<void> {
    if (this.#started.has(plugin)) return;
    this.#started.add(plugin);
    const cleanup = await plugin.setup(this);
    if (typeof cleanup !== "function") return;
    if (this.#closing === undefined) this.#cleanups.push(cleanup);
    else await this.#runCleanup(cleanup);
  }

  /** Undoes the setup of every plugin, the last one first. The plugins can be set up again after. */
  async #cleanUpPlugins(): Promise<void> {
    const cleanups = this.#cleanups.splice(0).reverse();
    this.#started.clear();
    for (const cleanup of cleanups) await this.#runCleanup(cleanup);
  }

  /** A cleanup that fails is reported, and does not keep the others from running. */
  async #runCleanup(cleanup: () => void | Promise<void>): Promise<void> {
    try {
      await cleanup();
    } catch (error) {
      this.#reportError({ error, source: "plugin", event: undefined, device: undefined });
    }
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

  /** Starts reading a link a transport hands over. */
  #accept(transport: Transport, link: Link): void {
    if (this.#closing !== undefined) {
      link.close("closed");
      return;
    }
    this.#links.add(link);
    const reader = this.#acceptLink(transport, link).finally(() => {
      this.#links.delete(link);
      this.#readers.delete(reader);
    });
    this.#readers.add(reader);
  }

  /**
   * Reads the frames of a link until it ends. The first one has to be a hello, and has to come in time.
   * A device that has said hello is watched, so that its session ends when its budget runs out
   * or, without a budget, when it goes quiet for too long.
   */
  async #acceptLink(transport: Transport, link: Link): Promise<void> {
    const { logger } = this.#options;
    let connection: Connection | undefined;
    let failure: RKError | undefined;
    const helloTimer = setTimeout(() => {
      logger.warn("closing link: no hello in time");
      link.close("hello timeout");
    }, HELLO_TIMEOUT);
    helloTimer.unref();
    try {
      for await (const raw of link.frames) {
        if (connection?.session.ended) break;
        const result = await intake(raw, this.#tokenOf, connection?.session);
        if (result.kind === "ignore") {
          logger.debug(`ignored a frame: ${result.reason}`);
          continue;
        }
        if (result.kind === "close") {
          logger.warn(`closing link: ${result.reason}`);
          link.close(result.code);
          break;
        }

        const { frame } = result.incoming;
        connection?.touch();
        if (connection === undefined) {
          if (frame.t !== "hello") {
            logger.warn("closing link: expected hello");
            link.close("PROTOCOL_ERROR");
            break;
          }
          clearTimeout(helloTimer);
          connection = await this.#acceptHello(
            transport,
            link,
            result.incoming,
            frame,
            result.keys,
          );
          if (connection === undefined) break;
        } else {
          this.#handleFrame(connection, link, frame);
        }
      }
    } catch (error) {
      failure = new RKError("PROTOCOL_ERROR", "link failed", { cause: error });
      this.#reportError({
        error,
        source: "transport",
        event: undefined,
        device: connection?.device,
      });
    } finally {
      clearTimeout(helloTimer);
      if (connection !== undefined)
        this.#endSession(connection.device, connection.session, failure);
    }
  }

  /**
   * Starts the session the hello asks for, or refuses the hello and closes the link.
   * Returns `undefined` when the link was closed.
   */
  async #acceptHello(
    transport: Transport,
    link: Link,
    incoming: IncomingFrame,
    hello: Hello,
    keys: SessionKeys | undefined,
  ): Promise<Connection | undefined> {
    const { auth, heartbeat, logger } = this.#options;
    const verdict = await checkHello(hello, {
      device: incoming.device,
      salt: incoming.salt,
      transport: transport.name,
      remoteAddress: link.remoteAddress,
      saltCache: this.#saltCache,
      verify: auth === false ? undefined : auth.verify?.bind(auth),
      onVerifyError: (error) =>
        this.#reportError({ error, source: "device", event: undefined, device: undefined }),
    });
    if (!verdict.accepted) {
      logger.warn(`closing link: ${verdict.reason}`);
      if (verdict.reject !== undefined)
        await sendReject(link, incoming.device, keys, verdict.reject);
      link.close(verdict.code);
      return undefined;
    }

    const device = this.#describeDevice(hello);
    const session = new SessionState({
      id: randomUUID(),
      device: device.id,
      transport: transport.name,
      link,
      keys,
      budget: hello.budget,
    });

    const previous = device.session;
    if (previous !== undefined) {
      this.#endSession(device, previous, undefined);
      previous.link.close("replaced by a new session");
    }
    await session.send({
      t: "welcome",
      v: PROTOCOL_VERSION,
      session: session.id,
      ...(hello.budget === undefined ? { heartbeat: heartbeat.interval } : {}),
    });
    device.attachSession(session);
    const connection = { device, session, touch: this.#watch(device, session) };
    void this.#emitter.emit("deviceConnect", device);
    this.#maybeIdle(device);
    return connection;
  }

  /**
   * Ends the session when its budget runs out, or, if it has none, when no frame arrives for
   * `heartbeat.timeout` ms. Returns the function that tells that a frame arrived.
   */
  #watch(device: DeviceState, session: SessionState): () => void {
    const { heartbeat } = this.#options;
    const watchdog = (ms: number, expire: () => void) => {
      let timer = setTimeout(expire, ms);
      timer.unref();
      session.onEnd(() => clearTimeout(timer));
      return () => {
        clearTimeout(timer);
        timer = setTimeout(expire, ms);
        timer.unref();
      };
    };

    if (session.expiresAt !== undefined) {
      watchdog(session.expiresAt.getTime() - Date.now(), () => {
        this.#endSession(device, session, undefined);
        session.link.close("budget expired");
      });
      return () => {};
    }
    return watchdog(heartbeat.timeout, () => {
      const error = new RKError("TIMEOUT", `no frame from the device for ${heartbeat.timeout} ms`);
      this.#endSession(device, session, error);
      session.link.close("heartbeat timeout");
    });
  }

  /** Acts on a frame the device sent while its session is open. */
  #handleFrame(connection: Connection, link: Link, frame: ClientFrame): void {
    const { device, session } = connection;
    switch (frame.t) {
      case "event":
        this.#handleEvent(connection, frame);
        break;
      case "res":
        device.handleResponse(frame);
        break;
      case "req":
        // Version 1 has no methods that devices can call on Node.
        this.#reply(session, {
          t: "res",
          id: frame.id,
          ok: false,
          error: { code: "UNSUPPORTED", message: "Node has no method that devices can call" },
        });
        break;
      case "ping":
        this.#reply(session, { t: "pong" });
        break;
      case "pong":
        session.resolvePing();
        break;
      case "bye":
        this.#endSession(device, session, undefined);
        link.close("bye");
        break;
      case "hello":
        // The session already started.
        break;
    }
  }

  /**
   * Passes an event of the device on to the listeners, unless the device sent it before, and acks it.
   * The ack means Node received the event, not that the listeners finished.
   */
  #handleEvent(connection: Connection, frame: EventFrame): void {
    const { device, session } = connection;
    if (typeof frame.id !== "string" || typeof frame.name !== "string") {
      this.#options.logger.warn("ignored an event with no id or name");
      return;
    }
    session.idleNotified = false;
    if (device.acceptEvent(frame.id)) {
      if (frame.name === "message") this.#dispatchMessage(connection, frame);
      else if (frame.name.includes(":")) this.#dispatchExtensionEvent(connection, frame);
    }
    this.#reply(session, { t: "ack", ids: [frame.id] });
  }

  /** An invalid message is reported and still acked, as the device would otherwise send it forever. */
  #dispatchMessage({ device, session }: Connection, frame: EventFrame): void {
    const problem =
      frame.appInstance === undefined
        ? "message event has no appInstance"
        : wireMessageProblem(frame.data);
    if (problem !== undefined) {
      const error = new RKError("PROTOCOL_ERROR", `device sent an invalid message: ${problem}`, {
        device,
      });
      this.#reportError({ error, source: "device", event: undefined, device });
      return;
    }
    const appInstance = this.#ensureAppInstance(device, frame.appInstance!);
    const message = new MessageImpl(appInstance, frame.data as WireMessage, frame.replay === true);
    this.#dispatch(device, session, "message", message);
  }

  #dispatchExtensionEvent({ device, session }: Connection, frame: EventFrame): void {
    const payload: ExtensionEvent<unknown> = {
      device,
      appInstance:
        frame.appInstance === undefined
          ? undefined
          : this.#ensureAppInstance(device, frame.appInstance),
      data: frame.data,
    };
    this.#dispatch(device, session, frame.name as EventName, payload as never);
  }

  /** Emits the event. The session is not idle until its listeners have finished. */
  #dispatch<E extends EventName>(
    device: DeviceState,
    session: SessionState,
    event: E,
    payload: EventPayload<E>,
  ): void {
    session.openDispatches += 1;
    void this.#emitter.emit(event, payload).finally(() => {
      session.openDispatches -= 1;
      this.#maybeIdle(device);
    });
  }

  /** Sends a frame the device does not wait for. A failure means the link is broken, which is handled where the link is read. */
  #reply(session: SessionState, frame: ServerFrame): void {
    session.send(frame).catch((error: unknown) => {
      this.#options.logger.debug(`could not send a ${frame.t} frame: ${String(error)}`);
    });
  }

  /** Records what the hello says about the device and its app instances. */
  #describeDevice(hello: Hello): DeviceState {
    const device = this.#ensureDevice(hello.device.id);
    device.name = hello.device.name;
    device.platform = hello.device.platform;
    device.client = hello.client;
    device.protocolVersion = hello.v;
    device.described = true;
    device.capabilities.clear();
    for (const capability of hello.caps) device.capabilities.add(capability);
    for (const wire of hello.appInstances) {
      const appInstance = this.#ensureAppInstance(device, wire.id);
      appInstance.me = wire.me === undefined ? undefined : new UserImpl(appInstance, wire.me);
    }
    return device;
  }

  /** Ends the session, unless it already ended, and tells about it with `deviceDisconnect`. */
  #endSession(device: DeviceState, session: SessionState, error: RKError | undefined): void {
    if (session.ended) return;
    const wasCurrent = device.session === session;
    device.detachSession(session);
    if (wasCurrent) void this.#emitter.emit("deviceDisconnect", { device, error });
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

/** Answers a `hello` that was refused. There is no session yet, so the frame is sealed with the counter 0. */
async function sendReject(
  link: Link,
  device: DeviceId,
  keys: SessionKeys | undefined,
  reject: Reject,
): Promise<void> {
  const frame: ServerFrame = reject;
  const bytes = sealFrame(
    frame,
    keys === undefined
      ? { direction: Direction.Down, device }
      : { direction: Direction.Down, device, salt: keys.salt, counter: 0n, key: keys.down },
  );
  try {
    await link.send(bytes);
  } catch {
    // The link is about to be closed anyway.
  }
}

/** Resolves when the promise does, or after `ms`, whichever comes first. */
async function within(ms: number, promise: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
