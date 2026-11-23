import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ReplayWindow } from "../src/replay-window.ts";

/** Offers each counter in order and returns whether each was accepted. Takes plain numbers instead of bigints. */
function acceptAll(window: ReplayWindow, ...counters: number[]): boolean[] {
  return counters.map((counter) => window.accept(BigInt(counter)));
}

describe("ReplayWindow", () => {
  it("accepts counters in order, and refuses one that comes again", () => {
    const window = new ReplayWindow();

    assert.deepEqual(acceptAll(window, 0, 1, 2, 1, 2, 0, 3), [
      true,
      true,
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("accepts a counter that comes late, once", () => {
    const window = new ReplayWindow();

    assert.deepEqual(acceptAll(window, 5, 3, 3, 4, 5, 4), [true, true, false, true, false, false]);
  });

  it("accepts a first counter that is not 0, and the older ones that were lost", () => {
    const window = new ReplayWindow();

    assert.deepEqual(acceptAll(window, 5, 0, 4), [true, true, true]);
  });

  describe("the window of 64", () => {
    it("accepts a counter 63 behind the highest, and refuses 64 behind", () => {
      const window = new ReplayWindow();
      window.accept(100n);

      assert.deepEqual(acceptAll(window, 37, 36, 0), [true, false, false]);
    });

    it("refuses a counter that is too old even though it was never seen", () => {
      const window = new ReplayWindow();
      acceptAll(window, 0, 64);

      assert.equal(window.accept(1n), true); // 63 behind 64
      assert.equal(window.accept(65n), true);
      assert.equal(window.accept(1n), false); // seen
      assert.equal(window.accept(2n), true); // 63 behind 65
      assert.equal(window.accept(66n), true);
      assert.equal(window.accept(3n), true); // 63 behind 66
      assert.equal(window.accept(67n), true);
      assert.equal(window.accept(3n), false); // 64 behind 67, and seen
      assert.equal(window.accept(4n), true); // 63 behind 67
    });

    it("forgets everything older than the window after a big jump", () => {
      const window = new ReplayWindow();
      acceptAll(window, 0, 1, 2);

      assert.equal(window.accept(1000n), true);
      assert.deepEqual(acceptAll(window, 0, 1, 2, 936, 937, 999), [
        false,
        false,
        false,
        false,
        true,
        true,
      ]);
      assert.equal(window.accept(1000n), false);
    });

    it("remembers the counters that were seen when the highest moves on a little", () => {
      const window = new ReplayWindow();
      acceptAll(window, 10, 11, 12);
      window.accept(20n);

      assert.deepEqual(acceptAll(window, 10, 11, 12, 13), [false, false, false, true]);
    });
  });

  it("jumps from a counter that was seen to the end of the range", () => {
    const window = new ReplayWindow();
    window.accept(0n);

    assert.equal(window.accept(2n ** 64n - 1n), true);
    assert.equal(window.accept(0n), false);
  });

  it("stays fast over a million counters, so it keeps no more than the window", () => {
    const window = new ReplayWindow();
    const started = performance.now();

    for (let counter = 0n; counter < 1_000_000n; counter++) window.accept(counter);

    // About 50 ms. Keeping every counter instead of the latest 64 takes several seconds.
    assert.ok(performance.now() - started < 2000);
  });

  it("works at the end of the range of 64 bits", () => {
    const window = new ReplayWindow();
    const last = 2n ** 64n - 1n;

    assert.equal(window.accept(last), true);
    assert.equal(window.accept(last), false);
    assert.equal(window.accept(last - 1n), true);
    assert.equal(window.accept(last - 64n), false);
  });

  it("refuses a counter that is not a number of 64 bits", () => {
    const window = new ReplayWindow();

    assert.equal(window.accept(-1n), false);
    assert.equal(window.accept(2n ** 64n), false);
    assert.equal(window.accept(0n), true);
  });

  it("agrees with a plain model on a long run of random counters", () => {
    const window = new ReplayWindow();
    const seen = new Set<bigint>();
    let highest = -1n;
    let state = 12345;
    const random = (limit: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % limit;
    };

    for (let step = 0; step < 20000; step++) {
      // Mostly close to the highest counter, now and then a jump forward or far back.
      const base = highest < 0n ? 0 : Number(highest);
      const counter = BigInt(Math.max(0, base + random(160) - 90 + (random(50) === 0 ? 300 : 0)));
      const expected = !seen.has(counter) && (highest < 0n || counter > highest - 64n);

      assert.equal(window.accept(counter), expected, `step ${step}, counter ${counter}`);
      if (expected) {
        seen.add(counter);
        if (counter > highest) highest = counter;
      }
    }
  });
});
