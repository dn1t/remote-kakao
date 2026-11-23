import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FrameQueue } from "../src/frame-queue.ts";

const frame = (...bytes: number[]) => new Uint8Array(bytes);

async function collect(queue: FrameQueue): Promise<number[][]> {
  const frames: number[][] = [];
  for await (const item of queue) frames.push(Array.from(item));
  return frames;
}

/** Runs `action` after the current reads have started waiting. */
function later(action: () => void): void {
  setImmediate(action);
}

describe("FrameQueue", () => {
  it("gives the frames that were pushed before reading, in order", async () => {
    const queue = new FrameQueue();
    queue.push(frame(1));
    queue.push(frame(2, 2));
    queue.push(frame(3));
    queue.end();

    assert.deepEqual(await collect(queue), [[1], [2, 2], [3]]);
  });

  it("waits for frames that are pushed while reading", async () => {
    const queue = new FrameQueue();
    later(() => queue.push(frame(1)));
    later(() => later(() => queue.push(frame(2))));
    later(() => later(() => later(() => queue.end())));

    assert.deepEqual(await collect(queue), [[1], [2]]);
  });

  it("gives the same frame object that was pushed", async () => {
    const queue = new FrameQueue();
    const pushed = frame(7);
    queue.push(pushed);
    queue.end();

    for await (const item of queue) assert.equal(item, pushed);
  });

  describe("end", () => {
    it("lets the reader finish the frames that are queued first", async () => {
      const queue = new FrameQueue();
      queue.push(frame(1));
      queue.end();
      queue.push(frame(2));

      assert.deepEqual(await collect(queue), [[1]]);
    });

    it("finishes a read that is waiting", async () => {
      const queue = new FrameQueue();
      later(() => queue.end());

      assert.deepEqual(await collect(queue), []);
    });

    it("can be called again, and after a failure", async () => {
      const queue = new FrameQueue();
      queue.end();
      queue.end();
      queue.fail(new Error("late"));

      assert.deepEqual(await collect(queue), []);
    });
  });

  describe("fail", () => {
    it("throws the error after the frames that are queued", async () => {
      const queue = new FrameQueue();
      const error = new Error("broke");
      queue.push(frame(1));
      queue.fail(error);
      const read: number[][] = [];

      await assert.rejects(
        async () => {
          for await (const item of queue) read.push(Array.from(item));
        },
        (thrown) => thrown === error,
      );
      assert.deepEqual(read, [[1]]);
    });

    it("rejects a read that is waiting", async () => {
      const queue = new FrameQueue();
      const error = new Error("broke");
      later(() => queue.fail(error));

      await assert.rejects(collect(queue), (thrown) => thrown === error);
    });

    it("throws even when the error is undefined", async () => {
      const queue = new FrameQueue();
      queue.fail(undefined);
      let threw = false;

      try {
        await collect(queue);
      } catch {
        threw = true;
      }
      assert.equal(threw, true);
    });

    it("ignores frames and a later end", async () => {
      const queue = new FrameQueue();
      queue.fail(new Error("broke"));
      queue.push(frame(1));
      queue.end();

      await assert.rejects(collect(queue), /broke/);
    });
  });

  describe("stopping early", () => {
    it("ends the queue when the loop is left with break", async () => {
      const queue = new FrameQueue();
      queue.push(frame(1));
      queue.push(frame(2));

      for await (const item of queue) {
        assert.deepEqual(Array.from(item), [1]);
        break;
      }
      queue.push(frame(3));

      assert.deepEqual(await collect(queue), [[2]]);
    });
  });

  describe("a second read at the same time", () => {
    it("is refused, and the first read still gets its frame", async () => {
      const queue = new FrameQueue();
      const iterator = queue[Symbol.asyncIterator]();
      const first = iterator.next();
      const second = iterator.next();

      await assert.rejects(second, /already being read/);
      queue.push(frame(9));

      assert.deepEqual(await first, { value: frame(9), done: false });
    });
  });
});
