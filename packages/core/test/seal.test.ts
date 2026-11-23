import assert from "node:assert/strict";
import { createDecipheriv, createHmac } from "node:crypto";
import { describe, it } from "node:test";

import type { AnyFrame } from "../src/protocol.ts";
import { deriveKey, Direction, openFrame, peekHeader, sealFrame } from "../src/seal.ts";

/**
 * Own implementation of HKDF-SHA256 (RFC 5869), using only HMAC.
 * Shares no code with `deriveKey`, so it can check it independently.
 */
function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter++) {
    const input = Buffer.concat([previous, info, Buffer.from([counter])]);
    previous = createHmac("sha256", prk).update(input).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const SALT = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

describe("hkdf test helper", () => {
  it("matches RFC 5869 test case 1", () => {
    const okm = hkdf(
      Buffer.alloc(22, 0x0b),
      Buffer.from("000102030405060708090a0b0c", "hex"),
      Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex"),
      42,
    );

    assert.equal(
      okm.toString("hex"),
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });
});

describe("deriveKey", () => {
  // Fixed vector: the iOS and Android clients must derive these exact bytes from the same input.
  it("derives the known keys for a token and salt", () => {
    assert.equal(
      deriveKey("test-token", SALT, Direction.Up).toString("hex"),
      "24f00e4dbfde077da409a6df8a2d8529e7fcd1c3cb6e1aa3e2cf0cfead2b3309",
    );
    assert.equal(
      deriveKey("test-token", SALT, Direction.Down).toString("hex"),
      "03c742fa27788375e22fa36d67f3787e0d5f9b1349aa9c7b3755965be6416fd2",
    );
  });

  it("is HKDF-SHA256 with a label per direction", () => {
    const token = "비밀 token";

    assert.deepEqual(
      deriveKey(token, SALT, Direction.Up),
      hkdf(Buffer.from(token, "utf8"), SALT, Buffer.from("rk wire v1 up"), 32),
    );
    assert.deepEqual(
      deriveKey(token, SALT, Direction.Down),
      hkdf(Buffer.from(token, "utf8"), SALT, Buffer.from("rk wire v1 down"), 32),
    );
  });

  it("returns 32 bytes, the size of an AES-256 key", () => {
    assert.equal(deriveKey("t", SALT, Direction.Up).length, 32);
  });

  it("gives the same key for the same input", () => {
    assert.deepEqual(deriveKey("t", SALT, Direction.Up), deriveKey("t", SALT, Direction.Up));
  });

  it("gives a different key when the direction, salt or token differs", () => {
    const base = deriveKey("t", SALT, Direction.Up);
    const otherSalt = Buffer.from(SALT);
    otherSalt[0] = 0xff;

    assert.notDeepEqual(deriveKey("t", SALT, Direction.Down), base);
    assert.notDeepEqual(deriveKey("t", otherSalt, Direction.Up), base);
    assert.notDeepEqual(deriveKey("u", SALT, Direction.Up), base);
  });
});

const KEY = deriveKey("test-token", SALT, Direction.Up);
const PING: AnyFrame = { t: "ping" };

/** Decrypts a sealed frame by reading its layout directly, without `openFrame`. */
function decrypt(bytes: Uint8Array, key: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const aadEnd = 3 + buf[2]! + 16 + 8;
  const nonce = Buffer.concat([Buffer.alloc(4), buf.subarray(aadEnd - 8, aadEnd)]);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);

  decipher.setAAD(buf.subarray(0, aadEnd));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  const plain = decipher.update(buf.subarray(aadEnd, buf.length - 16));

  return Buffer.concat([plain, decipher.final()]).toString("utf8");
}

function seal(frame: AnyFrame, overrides: { device?: string; counter?: bigint } = {}) {
  return Buffer.from(
    sealFrame(frame, {
      direction: Direction.Up,
      device: overrides.device ?? "phone",
      salt: SALT,
      counter: overrides.counter ?? 0n,
      key: KEY,
    }),
  );
}

describe("sealFrame, plain", () => {
  // Fixed vector for the other clients.
  it("writes the header and then the JSON", () => {
    const bytes = sealFrame(PING, { direction: Direction.Up, device: "phone" });

    assert.equal(Buffer.from(bytes).toString("hex"), "00000570686f6e657b2274223a2270696e67227d");
  });

  it("puts the direction in the second byte", () => {
    const bytes = sealFrame(PING, { direction: Direction.Down, device: "phone" });

    assert.equal(bytes[1], 1);
  });
});

describe("sealFrame, sealed", () => {
  // Fixed vector for the other clients: token "test-token", salt 00..0f, counter 0, device "phone".
  it("produces the known bytes for a known input", () => {
    assert.equal(
      seal(PING).toString("hex"),
      "01000570686f6e65000102030405060708090a0b0c0d0e0f000000000000000001" +
        "752b7f1caedcf31a2f4f1aae488869263ec1cc083be379d0386b0b",
    );
  });

  it("lays out version, direction, device id, salt, counter, ciphertext and tag", () => {
    const bytes = seal(PING);
    const json = Buffer.from(JSON.stringify(PING));

    assert.equal(bytes[0], 0x01);
    assert.equal(bytes[1], Direction.Up);
    assert.equal(bytes[2], 5);
    assert.equal(bytes.toString("utf8", 3, 8), "phone");
    assert.deepEqual(bytes.subarray(8, 24), SALT);
    assert.equal(bytes.readBigUInt64BE(24), 0n);
    assert.equal(bytes.length, 3 + 5 + 16 + 8 + json.length + 16);
  });

  it("encrypts the JSON so that the key opens it", () => {
    assert.equal(decrypt(seal(PING), KEY), '{"t":"ping"}');
    assert.equal(seal(PING).includes('{"t":"ping"}'), false);
  });

  it("writes the counter as 8 big-endian bytes", () => {
    const counter = 0x0102030405060708n;
    const bytes = seal(PING, { counter });

    assert.equal(bytes.toString("hex", 24, 32), "0102030405060708");
    assert.equal(decrypt(bytes, KEY), '{"t":"ping"}');
    assert.equal(seal(PING, { counter: 2n ** 64n - 1n }).readBigUInt64BE(24), 2n ** 64n - 1n);
  });

  it("measures the device id in bytes, not characters", () => {
    const bytes = seal(PING, { device: "폰" });

    assert.equal(bytes[2], 3);
    assert.equal(bytes.toString("utf8", 3, 6), "폰");
    assert.equal(decrypt(bytes, KEY), '{"t":"ping"}');
  });

  it("carries non-ASCII text in the frame", () => {
    const message: AnyFrame = { t: "bye", reason: "안녕 👋" };

    assert.equal(decrypt(seal(message), KEY), JSON.stringify(message));
  });

  it("gives the same bytes for the same input and other bytes for another counter", () => {
    assert.deepEqual(seal(PING), seal(PING));
    assert.notDeepEqual(seal(PING, { counter: 1n }), seal(PING));
  });

  it("authenticates the header, so changing it breaks decryption", () => {
    const bytes = seal(PING);
    bytes[3] = bytes[3]! ^ 0x01;

    assert.throws(() => decrypt(bytes, KEY));
  });

  it("authenticates the ciphertext, so changing it breaks decryption", () => {
    const bytes = seal(PING);
    bytes[bytes.length - 17] = bytes[bytes.length - 17]! ^ 0x01;

    assert.throws(() => decrypt(bytes, KEY));
  });
});

describe("sealFrame, invalid input", () => {
  it("accepts a device id of 255 bytes and rejects 256", () => {
    assert.equal(seal(PING, { device: "a".repeat(255) })[2], 255);
    assert.throws(() => seal(PING, { device: "a".repeat(256) }), RangeError);
    assert.throws(
      () => sealFrame(PING, { direction: Direction.Up, device: "a".repeat(256) }),
      RangeError,
    );
  });

  it("rejects a salt that is not 16 bytes", () => {
    const params = { direction: Direction.Up, device: "phone", counter: 0n, key: KEY };

    assert.throws(() => sealFrame(PING, { ...params, salt: SALT.subarray(0, 15) }), RangeError);
  });

  it("rejects a counter outside 0 to 2^64 - 1", () => {
    assert.throws(() => seal(PING, { counter: -1n }), RangeError);
    assert.throws(() => seal(PING, { counter: 2n ** 64n }), RangeError);
  });

  it("rejects a key that is not 32 bytes", () => {
    const params = { direction: Direction.Up, device: "phone", salt: SALT, counter: 0n };

    assert.throws(() => sealFrame(PING, { ...params, key: KEY.subarray(0, 16) }), RangeError);
  });
});

const FRAMES: AnyFrame[] = [
  {
    t: "hello",
    v: 1,
    ts: 0,
    device: { id: "phone", name: "Phone", platform: "ios" },
    client: { name: "test", version: "1" },
    caps: ["room.send"],
    appInstances: [],
  },
  { t: "welcome", v: 1, session: "s1" },
  { t: "event", id: "boot-1", name: "message", data: null as never },
  { t: "ack", ids: ["boot-1"] },
  { t: "req", id: "q1", method: "room.send", params: { text: "안녕" }, ttl: 1000 },
  { t: "res", id: "q1", ok: false, error: { code: "NOT_FOUND", message: "no room" } },
  { t: "idle" },
  { t: "bye", reason: "done" },
];

function plain(frame: AnyFrame, device = "phone"): Buffer {
  return Buffer.from(sealFrame(frame, { direction: Direction.Up, device }));
}

describe("peekHeader", () => {
  it("reads the header of a sealed frame", () => {
    assert.deepEqual(peekHeader(seal(PING)), {
      sealed: true,
      direction: Direction.Up,
      device: "phone",
      salt: new Uint8Array(SALT),
    });
  });

  it("reads the header of a plain frame, which has no salt", () => {
    assert.deepEqual(peekHeader(plain(PING, "폰")), {
      sealed: false,
      direction: Direction.Up,
      device: "폰",
      salt: new Uint8Array(0),
    });
  });

  it("needs only the bytes up to the end of the salt", () => {
    assert.equal(peekHeader(seal(PING).subarray(0, 3 + 5 + 16))?.device, "phone");
  });

  it("returns undefined for a header that is cut short", () => {
    const bytes = seal(PING);

    for (let length = 0; length < 3 + 5 + 16; length++) {
      assert.equal(peekHeader(bytes.subarray(0, length)), undefined, `length ${length}`);
    }
  });

  it("returns undefined for an unknown version or direction", () => {
    const badVersion = seal(PING);
    badVersion[0] = 0x02;
    const badDirection = seal(PING);
    badDirection[1] = 0x02;

    assert.equal(peekHeader(badVersion), undefined);
    assert.equal(peekHeader(badDirection), undefined);
  });

  it("keeps a byte order mark at the start of the device id", () => {
    assert.equal(peekHeader(plain(PING, "\uFEFFphone"))?.device, "\uFEFFphone");
    assert.equal(openFrame(seal(PING, { device: "\uFEFFphone" }), KEY)?.device, "\uFEFFphone");
  });

  it("returns undefined for a device id that is not UTF-8", () => {
    const bytes = Buffer.from([0x00, Direction.Up, 0x01, 0xff, 0x7b, 0x7d]);

    assert.equal(peekHeader(bytes), undefined);
  });

  it("returns a copy of the salt, not a view of the bytes", () => {
    const bytes = seal(PING);
    const header = peekHeader(bytes)!;
    header.salt[0] = 0xff;

    assert.equal(bytes[8], 0x00);
  });
});

describe("openFrame, sealed", () => {
  it("opens what sealFrame made, for every kind of frame", () => {
    for (const frame of FRAMES) {
      const opened = openFrame(seal(frame), KEY);

      assert.deepEqual(opened?.frame, frame);
    }
  });

  it("returns the header and the counter along with the frame", () => {
    const opened = openFrame(seal(PING, { device: "폰", counter: 0x0102030405060708n }), KEY);

    assert.deepEqual(opened, {
      sealed: true,
      direction: Direction.Up,
      device: "폰",
      salt: new Uint8Array(SALT),
      counter: 0x0102030405060708n,
      frame: PING,
    });
  });

  it("opens the known frame", () => {
    const bytes = Buffer.from(
      "01000570686f6e65000102030405060708090a0b0c0d0e0f000000000000000001" +
        "752b7f1caedcf31a2f4f1aae488869263ec1cc083be379d0386b0b",
      "hex",
    );
    const opened = openFrame(bytes, KEY);

    assert.deepEqual(opened?.frame, PING);
    assert.equal(opened?.counter, 0n);
    assert.equal(opened?.device, "phone");
  });

  it("opens bytes that are a view into a larger buffer", () => {
    const bytes = seal(PING);
    const larger = Buffer.alloc(bytes.length + 10);
    bytes.copy(larger, 5);

    assert.deepEqual(openFrame(larger.subarray(5, 5 + bytes.length), KEY)?.frame, PING);
  });

  it("refuses another key, including the key of the other direction", () => {
    assert.equal(openFrame(seal(PING), deriveKey("other", SALT, Direction.Up)), undefined);
    assert.equal(openFrame(seal(PING), deriveKey("test-token", SALT, Direction.Down)), undefined);
  });

  it("refuses a frame in which any single bit was changed", () => {
    const bytes = seal(PING);

    for (let index = 0; index < bytes.length; index++) {
      const changed = Buffer.from(bytes);
      changed[index] = changed[index]! ^ 0x01;

      assert.equal(openFrame(changed, KEY), undefined, `byte ${index}`);
    }
  });

  it("refuses a frame that is cut short or has bytes added", () => {
    const bytes = seal(PING);

    for (let length = 0; length < bytes.length; length++) {
      assert.equal(openFrame(bytes.subarray(0, length), KEY), undefined, `length ${length}`);
    }
    assert.equal(openFrame(Buffer.concat([bytes, Buffer.from([0])]), KEY), undefined);
  });

  it("refuses sealed JSON that is not a frame", () => {
    const notFrames = [42, null, "ping", [], {}, { t: 1 }, { t: "nope" }, { t: "constructor" }];

    for (const value of notFrames) {
      assert.equal(openFrame(seal(value as unknown as AnyFrame), KEY), undefined);
    }
  });

  it("refuses a sealed frame when there is no key", () => {
    assert.equal(openFrame(seal(PING)), undefined);
  });

  it("throws when the key is not 32 bytes", () => {
    assert.throws(() => openFrame(seal(PING), KEY.subarray(0, 16)), RangeError);
  });
});

describe("openFrame, plain", () => {
  it("opens what sealFrame made without a key, for every kind of frame", () => {
    for (const frame of FRAMES) {
      assert.deepEqual(openFrame(plain(frame))?.frame, frame);
    }
  });

  it("returns the header, with no salt and counter 0", () => {
    assert.deepEqual(openFrame(plain(PING, "폰")), {
      sealed: false,
      direction: Direction.Up,
      device: "폰",
      salt: new Uint8Array(0),
      counter: 0n,
      frame: PING,
    });
  });

  it("refuses a plain frame when a key is given, so it cannot replace a sealed one", () => {
    assert.equal(openFrame(plain(PING), KEY), undefined);
  });

  it("refuses a body that is not valid JSON, not UTF-8 or not a frame", () => {
    const head = plain(PING).subarray(0, 8);

    assert.equal(openFrame(Buffer.concat([head, Buffer.from("{not json")])), undefined);
    assert.equal(openFrame(Buffer.concat([head, Buffer.from([0xff, 0xfe])])), undefined);
    assert.equal(openFrame(Buffer.concat([head, Buffer.from('{"t":"nope"}')])), undefined);
  });
});
