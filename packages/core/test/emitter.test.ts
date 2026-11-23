import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, describe, it, mock } from "node:test";

import { Emitter } from "../src/emitter.ts";
import { isRKError } from "../src/errors.ts";
import type { EventName, EventPayload } from "../src/types.ts";

type Report = EventPayload<"error">;

const report = (label: string): Report => ({
  error: label,
  source: "listener",
  event: undefined,
  device: undefined,
});

/** An emitter that records the errors of its listeners and the payloads it dropped. */
function create() {
  const errors: { error: unknown; event: EventName }[] = [];
  const drops: { event: EventName; dropped: number }[] = [];
  const emitter = new Emitter({
    onListenerError: (error, event) => errors.push({ error, event }),
    onDrop: (event, dropped) => drops.push({ event, dropped }),
  });
  return { emitter, errors, drops };
}

/** A promise that is settled by hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Emitter, on and emit", () => {
  it("calls the listeners of an event in the order they were added", async () => {
    const { emitter } = create();
    const calls: string[] = [];
    emitter.on("error", () => calls.push("a"));
    emitter.on("error", () => calls.push("b"));
    emitter.on("deviceConnect", () => calls.push("other event"));

    await emitter.emit("error", report("x"));

    assert.deepEqual(calls, ["a", "b"]);
  });

  it("passes the payload to the listener", async () => {
    const { emitter } = create();
    const received: Report[] = [];
    emitter.on("error", (payload) => received.push(payload));
    const payload = report("x");

    await emitter.emit("error", payload);

    assert.equal(received[0], payload);
  });

  it("starts every listener before any async one has finished", async () => {
    const { emitter } = create();
    const gate = deferred();
    const calls: string[] = [];
    emitter.on("error", async () => {
      calls.push("first starts");
      await gate.promise;
      calls.push("first ends");
    });
    emitter.on("error", () => calls.push("second"));

    const done = emitter.emit("error", report("x"));
    assert.deepEqual(calls, ["first starts", "second"]);
    gate.resolve();
    await done;

    assert.deepEqual(calls, ["first starts", "second", "first ends"]);
  });

  it("resolves only after the async listeners of that call have settled", async () => {
    const { emitter } = create();
    const gate = deferred();
    emitter.on("error", () => gate.promise);
    let resolved = false;

    const done = emitter.emit("error", report("x")).then(() => (resolved = true));
    await tick();
    assert.equal(resolved, false);
    gate.resolve();
    await done;

    assert.equal(resolved, true);
  });

  it("does nothing for an event that has no listener", async () => {
    const { emitter, errors } = create();

    await emitter.emit("error", report("x"));

    assert.deepEqual(errors, []);
  });

  it("starts the listeners that are added during a call only from the next call", async () => {
    const { emitter } = create();
    const calls: string[] = [];
    emitter.on("error", () => {
      calls.push("first");
      emitter.on("error", () => calls.push("added"));
    });

    await emitter.emit("error", report("x"));
    assert.deepEqual(calls, ["first"]);
    await emitter.emit("error", report("y"));

    assert.deepEqual(calls, ["first", "first", "added"]);
  });

  it("does not call a listener that an earlier listener removed during the call", async () => {
    const { emitter } = create();
    const calls: string[] = [];
    let offSecond = () => {};
    emitter.on("error", () => {
      calls.push("first");
      offSecond();
    });
    offSecond = emitter.on("error", () => calls.push("second"));

    await emitter.emit("error", report("x"));

    assert.deepEqual(calls, ["first"]);
  });
});

describe("Emitter, once", () => {
  it("calls the listener one time", async () => {
    const { emitter } = create();
    let count = 0;
    emitter.once("error", () => count++);

    await emitter.emit("error", report("x"));
    await emitter.emit("error", report("y"));

    assert.equal(count, 1);
  });

  it("is not called again by an emit made from inside the listener", async () => {
    const { emitter } = create();
    let count = 0;
    emitter.once("error", () => {
      count++;
      void emitter.emit("error", report("again"));
    });

    await emitter.emit("error", report("x"));

    assert.equal(count, 1);
  });
});

describe("Emitter, removing a listener", () => {
  it("stops calling it once the returned function is called", async () => {
    const { emitter } = create();
    let count = 0;
    const off = emitter.on("error", () => count++);

    await emitter.emit("error", report("x"));
    off();
    off();
    await emitter.emit("error", report("y"));

    assert.equal(count, 1);
  });

  it("works with `using`", async () => {
    const { emitter } = create();
    let count = 0;
    {
      using _off = emitter.on("error", () => count++);
      await emitter.emit("error", report("x"));
    }
    await emitter.emit("error", report("y"));

    assert.equal(count, 1);
  });

  it("stops calling it when the signal is aborted", async () => {
    const { emitter } = create();
    const controller = new AbortController();
    let count = 0;
    emitter.on("error", () => count++, { signal: controller.signal });

    await emitter.emit("error", report("x"));
    controller.abort();
    await emitter.emit("error", report("y"));

    assert.equal(count, 1);
  });

  it("never adds a listener for a signal that is already aborted", async () => {
    const { emitter } = create();
    let count = 0;
    emitter.on("error", () => count++, { signal: AbortSignal.abort() });

    await emitter.emit("error", report("x"));

    assert.equal(count, 0);
    assert.equal(emitter.has("error"), false);
  });

  it("works for a listener that was added with once", async () => {
    const { emitter } = create();
    let count = 0;
    emitter.once("error", () => count++)();

    await emitter.emit("error", report("x"));

    assert.equal(count, 0);
  });
});

describe("Emitter, has", () => {
  it("tells whether the event has a listener", () => {
    const { emitter } = create();
    assert.equal(emitter.has("error"), false);

    const off = emitter.on("error", () => {});
    assert.equal(emitter.has("error"), true);
    assert.equal(emitter.has("deviceConnect"), false);

    off();
    assert.equal(emitter.has("error"), false);
  });
});

describe("Emitter, failing listeners", () => {
  it("reports a listener that throws and still calls the others", async () => {
    const { emitter, errors } = create();
    const calls: string[] = [];
    emitter.on("error", () => {
      throw new Error("boom");
    });
    emitter.on("error", () => calls.push("second"));

    await emitter.emit("error", report("x"));

    assert.equal(calls.length, 1);
    assert.deepEqual(
      errors.map(({ error }) => (error as Error).message),
      ["boom"],
    );
    assert.deepEqual(
      errors.map(({ event }) => event),
      ["error"],
    );
  });

  it("reports a listener that rejects, without making emit reject", async () => {
    const { emitter, errors } = create();
    emitter.on("error", async () => {
      throw new Error("later");
    });

    await emitter.emit("error", report("x"));

    assert.deepEqual(
      errors.map(({ error }) => (error as Error).message),
      ["later"],
    );
  });

  it("treats anything with a then method as async", async () => {
    const { emitter, errors } = create();
    const gate = deferred();
    // The listener returns a thenable on purpose, which is what this test is about.
    // oxlint-disable-next-line unicorn/no-thenable
    emitter.on("error", () => ({ then: (resolve: () => void) => gate.promise.then(resolve) }));
    let resolved = false;

    const done = emitter.emit("error", report("x")).then(() => (resolved = true));
    await tick();
    assert.equal(resolved, false);
    gate.resolve();
    await done;

    assert.deepEqual(errors, []);
  });

  it("does not let a hook that throws reach the process", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const emitter = new Emitter({
        onListenerError: () => {
          throw new Error("hook");
        },
        onDrop: () => {},
      });
      emitter.on("error", () => {
        throw new Error("sync");
      });
      emitter.on("error", async () => {
        throw new Error("async");
      });

      await emitter.emit("error", report("x"));
      await emitter.settle();
      await tick();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    assert.deepEqual(unhandled, []);
  });
});

describe("Emitter, settle", () => {
  it("waits for the async listeners that are running", async () => {
    const { emitter } = create();
    const gate = deferred();
    emitter.on("error", () => gate.promise);
    void emitter.emit("error", report("x"));
    let settled = false;

    const done = emitter.settle().then(() => (settled = true));
    await tick();
    assert.equal(settled, false);
    gate.resolve();
    await done;

    assert.equal(settled, true);
  });

  it("also waits for listeners that start while it waits", async () => {
    const { emitter } = create();
    const first = deferred();
    const second = deferred();
    emitter.once("error", () =>
      first.promise.then(() => void emitter.emit("deviceConnect", null as never)),
    );
    emitter.on("deviceConnect", () => second.promise);
    void emitter.emit("error", report("x"));
    let settled = false;

    const done = emitter.settle().then(() => (settled = true));
    first.resolve();
    await tick();
    assert.equal(settled, false);
    second.resolve();
    await done;

    assert.equal(settled, true);
  });

  it("returns at once when nothing is running", async () => {
    const { emitter } = create();

    await emitter.settle();
  });
});

afterEach(() => mock.timers.reset());

/** Whether the promise has settled once the work that is already waiting has run. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await tick();
  return settled;
}

describe("Emitter, wait", () => {
  it("resolves with the next payload, not with an earlier one", async () => {
    const { emitter } = create();
    await emitter.emit("error", report("before"));
    const next = report("next");

    const waiting = emitter.wait("error");
    await emitter.emit("error", next);

    assert.equal(await waiting, next);
  });

  it("skips the payloads that the filter refuses", async () => {
    const { emitter } = create();
    const waiting = emitter.wait("error", { filter: (payload) => payload.error === "b" });
    const wanted = report("b");

    await emitter.emit("error", report("a"));
    assert.equal(await isSettled(waiting), false);
    await emitter.emit("error", wanted);

    assert.equal(await waiting, wanted);
  });

  it("stops listening once it has settled", async () => {
    const { emitter } = create();
    const waiting = emitter.wait("error");
    assert.equal(emitter.has("error"), true);

    await emitter.emit("error", report("x"));
    await waiting;

    assert.equal(emitter.has("error"), false);
  });

  it("lets several waits for the same event settle on their own", async () => {
    const { emitter } = create();
    const first = emitter.wait("error");
    const second = emitter.wait("error", { filter: (payload) => payload.error === "later" });

    await emitter.emit("error", report("now"));

    assert.equal((await first).error, "now");
    assert.equal(await isSettled(second), false);
    await emitter.emit("error", report("later"));
    assert.equal((await second).error, "later");
  });

  it("rejects with the error of a filter that throws, and stops listening", async () => {
    const { emitter, errors } = create();
    const failure = new Error("bad filter");
    const waiting = emitter.wait("error", {
      filter: () => {
        throw failure;
      },
    });

    await emitter.emit("error", report("x"));

    await assert.rejects(waiting, (error) => error === failure);
    assert.equal(emitter.has("error"), false);
    assert.deepEqual(errors, []);
  });

  describe("with a timeout", () => {
    it("rejects with TIMEOUT once the time has passed", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const { emitter } = create();
      const waiting = emitter.wait("error", { timeout: 100 });
      const outcome = assert.rejects(waiting, (error) => {
        return isRKError(error, "TIMEOUT") && error.retryable && /error.*100ms/.test(error.message);
      });

      mock.timers.tick(99);
      assert.equal(await isSettled(waiting), false);
      mock.timers.tick(1);
      await outcome;

      assert.equal(emitter.has("error"), false);
    });

    it("resolves when the payload comes in time", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const { emitter } = create();
      const waiting = emitter.wait("error", { timeout: 100 });
      const payload = report("x");

      mock.timers.tick(50);
      await emitter.emit("error", payload);
      mock.timers.tick(1000);

      assert.equal(await waiting, payload);
    });

    it("does not leave its timer running once it has settled", async () => {
      const { emitter } = create();
      const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout");
      const before = timers().length;

      const waiting = emitter.wait("error", { timeout: 60_000 });
      assert.equal(timers().length, before + 1);
      await emitter.emit("error", report("x"));
      await waiting;

      assert.equal(timers().length, before);
    });

    it("waits without limit when there is no timeout", async () => {
      mock.timers.enable({ apis: ["setTimeout"] });
      const { emitter } = create();
      const waiting = emitter.wait("error");

      mock.timers.tick(10 ** 9);

      assert.equal(await isSettled(waiting), false);
    });
  });

  describe("with a signal", () => {
    it("rejects with ABORTED and the reason of the abort", async () => {
      const { emitter } = create();
      const controller = new AbortController();
      const reason = new Error("stop");
      const waiting = emitter.wait("error", { signal: controller.signal });

      controller.abort(reason);

      await assert.rejects(waiting, (error) => {
        return isRKError(error, "ABORTED") && error.cause === reason;
      });
      assert.equal(emitter.has("error"), false);
    });

    it("rejects at once for a signal that is already aborted, without listening", async () => {
      const { emitter } = create();

      await assert.rejects(emitter.wait("error", { signal: AbortSignal.abort() }), (error) => {
        return isRKError(error, "ABORTED");
      });
      assert.equal(emitter.has("error"), false);
    });

    it("does not leave its listener on the signal once it has settled", async () => {
      const { emitter } = create();
      const controller = new AbortController();
      const waiting = emitter.wait("error", { signal: controller.signal });
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);

      await emitter.emit("error", report("x"));
      await waiting;

      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });

    it("ignores an abort after the wait has settled", async () => {
      const { emitter } = create();
      const controller = new AbortController();
      const waiting = emitter.wait("error", { signal: controller.signal });
      const payload = report("x");

      await emitter.emit("error", payload);
      controller.abort();

      assert.equal(await waiting, payload);
    });
  });
});

describe("Emitter, close", () => {
  it("rejects the waits that are pending with CLOSED", async () => {
    const { emitter } = create();
    const first = emitter.wait("error");
    const second = emitter.wait("deviceConnect");

    emitter.close();

    for (const waiting of [first, second]) {
      await assert.rejects(waiting, (error) => isRKError(error, "CLOSED"));
    }
  });

  it("rejects every wait that starts afterwards", async () => {
    const { emitter } = create();
    emitter.close();

    await assert.rejects(emitter.wait("error"), (error) => isRKError(error, "CLOSED"));
    assert.equal(emitter.has("error"), false);
  });

  it("removes all listeners, and can be called again", async () => {
    const { emitter } = create();
    let count = 0;
    emitter.on("error", () => count++);

    emitter.close();
    emitter.close();
    await emitter.emit("error", report("x"));

    assert.equal(count, 0);
    assert.equal(emitter.has("error"), false);
  });

  it("stops the timer of a wait that it rejects", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { emitter } = create();
    const waiting = emitter.wait("error", { timeout: 100 });
    const outcome = assert.rejects(waiting, (error) => isRKError(error, "CLOSED"));

    emitter.close();
    mock.timers.tick(1000);

    await outcome;
  });
});

describe("Emitter, iterate", () => {
  it("gives the payloads that are emitted while the loop waits", async () => {
    const { emitter } = create();
    const seen: unknown[] = [];
    const loop = (async () => {
      for await (const payload of emitter.iterate("error")) {
        seen.push(payload.error);
        if (seen.length === 3) break;
      }
    })();

    for (const label of ["a", "b", "c"]) {
      await tick();
      await emitter.emit("error", report(label));
    }
    await loop;

    assert.deepEqual(seen, ["a", "b", "c"]);
  });

  it("keeps the payloads that come while the loop is busy, in order", async () => {
    const { emitter } = create();
    const iterator = emitter.iterate("error");

    await emitter.emit("error", report("a"));
    await emitter.emit("error", report("b"));

    assert.equal((await iterator.next()).value.error, "a");
    assert.equal((await iterator.next()).value.error, "b");
  });

  it("gives only the payloads that pass the filter", async () => {
    const { emitter } = create();
    const iterator = emitter.iterate("error", { filter: (payload) => payload.error !== "skip" });

    await emitter.emit("error", report("skip"));
    await emitter.emit("error", report("keep"));
    await emitter.emit("error", report("skip"));

    assert.equal((await iterator.next()).value.error, "keep");
    assert.equal(await isSettled(iterator.next()), false);
  });

  it("is its own async iterator", () => {
    const { emitter } = create();
    const iterator = emitter.iterate("error");

    assert.equal(iterator[Symbol.asyncIterator](), iterator);
  });

  it("listens only while the iteration lasts", async () => {
    const { emitter } = create();
    const iterator = emitter.iterate("error");
    assert.equal(emitter.has("error"), true);

    await iterator.return?.();

    assert.equal(emitter.has("error"), false);
  });

  describe("when the loop stops early", () => {
    it("ends the iteration, stops listening and drops what was kept", async () => {
      const { emitter } = create();
      const iterator = emitter.iterate("error");
      await emitter.emit("error", report("a"));
      await emitter.emit("error", report("b"));

      for await (const payload of iterator) {
        assert.equal(payload.error, "a");
        break;
      }

      assert.equal(emitter.has("error"), false);
      assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    });
  });

  describe("buffer", () => {
    it("drops the oldest payloads past the limit and tells the hook", async () => {
      const { emitter, drops } = create();
      const iterator = emitter.iterate("error", { buffer: 2 });

      for (const label of ["1", "2", "3", "4", "5"]) await emitter.emit("error", report(label));

      assert.deepEqual(drops, Array(3).fill({ event: "error", dropped: 1 }));
      assert.equal((await iterator.next()).value.error, "4");
      assert.equal((await iterator.next()).value.error, "5");
    });

    it("keeps 1000 payloads by default", async () => {
      const { emitter, drops } = create();
      const iterator = emitter.iterate("error");

      for (let index = 0; index < 1005; index++) await emitter.emit("error", report(`${index}`));

      assert.equal(drops.length, 5);
      assert.equal((await iterator.next()).value.error, "5");
    });

    it("does not drop a payload that a waiting loop takes at once", async () => {
      const { emitter, drops } = create();
      const iterator = emitter.iterate("error", { buffer: 1 });
      const next = iterator.next();

      await emitter.emit("error", report("a"));

      assert.equal((await next).value.error, "a");
      assert.deepEqual(drops, []);
    });

    it("must be a positive integer", () => {
      const { emitter } = create();

      for (const buffer of [0, -1, 1.5, Number.NaN, Infinity]) {
        assert.throws(() => emitter.iterate("error", { buffer }), RangeError);
      }
    });
  });

  describe("with a signal", () => {
    it("ends the iteration when it is aborted", async () => {
      const { emitter } = create();
      const controller = new AbortController();
      const iterator = emitter.iterate("error", { signal: controller.signal });
      const next = iterator.next();

      controller.abort();

      assert.deepEqual(await next, { value: undefined, done: true });
      assert.equal(emitter.has("error"), false);
    });

    it("ends at once for a signal that is already aborted", async () => {
      const { emitter } = create();
      const iterator = emitter.iterate("error", { signal: AbortSignal.abort() });

      assert.equal(emitter.has("error"), false);
      assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    });

    it("does not leave its listener on the signal once it has ended", async () => {
      const { emitter } = create();
      const controller = new AbortController();
      const iterator = emitter.iterate("error", { signal: controller.signal });
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);

      await iterator.return?.();

      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
  });

  describe("when the emitter is closed", () => {
    it("ends the iterations, without an error", async () => {
      const { emitter } = create();
      const iterator = emitter.iterate("error");
      const next = iterator.next();

      emitter.close();

      assert.deepEqual(await next, { value: undefined, done: true });
    });

    it("ends an iteration that starts afterwards", async () => {
      const { emitter } = create();
      emitter.close();
      const iterator = emitter.iterate("error");

      assert.deepEqual(await iterator.next(), { value: undefined, done: true });
      assert.equal(emitter.has("error"), false);
    });
  });

  describe("when the filter throws", () => {
    it("throws the error after the payloads that were kept, and then ends", async () => {
      const { emitter, errors } = create();
      const failure = new Error("bad filter");
      const iterator = emitter.iterate("error", {
        filter: (payload) => {
          if (payload.error === "bad") throw failure;
          return true;
        },
      });

      await emitter.emit("error", report("a"));
      await emitter.emit("error", report("bad"));

      assert.equal((await iterator.next()).value.error, "a");
      await assert.rejects(iterator.next(), (error) => error === failure);
      assert.deepEqual(await iterator.next(), { value: undefined, done: true });
      assert.equal(emitter.has("error"), false);
      assert.deepEqual(errors, []);
    });

    it("rejects the read that is waiting", async () => {
      const { emitter } = create();
      const failure = new Error("bad filter");
      const iterator = emitter.iterate("error", {
        filter: () => {
          throw failure;
        },
      });
      const next = iterator.next();

      await emitter.emit("error", report("x"));

      await assert.rejects(next, (error) => error === failure);
    });
  });

  describe("a second read at the same time", () => {
    it("is refused, and the first read still gets its payload", async () => {
      const { emitter } = create();
      const iterator = emitter.iterate("error");
      const first = iterator.next();
      const second = iterator.next();

      await assert.rejects(second, /already being read/);
      await emitter.emit("error", report("a"));

      assert.equal((await first).value.error, "a");
    });
  });
});
