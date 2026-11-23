import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { SaltCache } from "../src/salt-cache.ts";

const salt = (...bytes: number[]) => Uint8Array.from(bytes);

afterEach(() => mock.timers.reset());

describe("SaltCache", () => {
  it("accepts a salt the first time and refuses it after", () => {
    const cache = new SaltCache(1000);

    assert.equal(cache.add(salt(1, 2, 3)), true);
    assert.equal(cache.add(salt(1, 2, 3)), false);
    assert.equal(cache.add(salt(1, 2, 3)), false);
  });

  it("tells salts apart by their bytes", () => {
    const cache = new SaltCache(1000);

    assert.equal(cache.add(salt(1, 2, 3)), true);
    assert.equal(cache.add(salt(1, 2, 4)), true);
    assert.equal(cache.add(salt(1, 2)), true);
    assert.equal(cache.add(salt(0, 1, 2, 3)), true);
    assert.equal(cache.add(salt()), true);
    assert.equal(cache.size, 5);
  });

  it("does not depend on the view the bytes come in", () => {
    const cache = new SaltCache(1000);
    const backing = Uint8Array.from([9, 1, 2, 3, 9]);

    assert.equal(cache.add(backing.subarray(1, 4)), true);
    assert.equal(cache.add(salt(1, 2, 3)), false);
  });

  it("forgets a salt once its time is up, and accepts it again", () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const cache = new SaltCache(1000);
    cache.add(salt(1));

    mock.timers.tick(999);
    assert.equal(cache.add(salt(1)), false);
    mock.timers.tick(1);
    assert.equal(cache.add(salt(1)), true);
  });

  it("does not remember a salt longer because it was seen again", () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const cache = new SaltCache(1000);
    cache.add(salt(1));

    mock.timers.tick(600);
    assert.equal(cache.add(salt(1)), false);
    mock.timers.tick(400);
    assert.equal(cache.add(salt(1)), true);
  });

  it("forgets each salt on its own time", () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const cache = new SaltCache(1000);
    cache.add(salt(1));
    mock.timers.tick(500);
    cache.add(salt(2));

    mock.timers.tick(500);
    assert.equal(cache.add(salt(1)), true);
    assert.equal(cache.add(salt(2)), false);
    mock.timers.tick(500);
    assert.equal(cache.add(salt(2)), true);
  });

  it("drops the expired salts so that it does not grow without limit", () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const cache = new SaltCache(1000);
    for (let i = 0; i < 100; i++) {
      cache.add(salt(i));
      mock.timers.tick(10);
    }
    assert.equal(cache.size, 100);

    mock.timers.tick(5000);
    cache.add(salt(200));

    assert.equal(cache.size, 1);
  });
});
