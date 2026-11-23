import assert from "node:assert/strict";
import { createDecipheriv, createHmac } from "node:crypto";
import { describe, it } from "node:test";

import type { AnyFrame } from "../src/protocol.ts";
import { deriveKey, Direction, sealFrame } from "../src/seal.ts";

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

function seal(frame: AnyFrame, overrides: { deviceId?: string; counter?: bigint } = {}) {
  return Buffer.from(
    sealFrame(frame, {
      direction: Direction.Up,
      deviceId: overrides.deviceId ?? "phone",
      salt: SALT,
      counter: overrides.counter ?? 0n,
      key: KEY,
    }),
  );
}

describe("sealFrame, plain", () => {
  // Fixed vector for the other clients.
  it("writes the header and then the JSON", () => {
    const bytes = sealFrame(PING, { direction: Direction.Up, deviceId: "phone" });

    assert.equal(Buffer.from(bytes).toString("hex"), "00000570686f6e657b2274223a2270696e67227d");
  });

  it("puts the direction in the second byte", () => {
    const bytes = sealFrame(PING, { direction: Direction.Down, deviceId: "phone" });

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
    const bytes = seal(PING, { deviceId: "폰" });

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
    assert.equal(seal(PING, { deviceId: "a".repeat(255) })[2], 255);
    assert.throws(() => seal(PING, { deviceId: "a".repeat(256) }), RangeError);
    assert.throws(
      () => sealFrame(PING, { direction: Direction.Up, deviceId: "a".repeat(256) }),
      RangeError,
    );
  });

  it("rejects a salt that is not 16 bytes", () => {
    const params = { direction: Direction.Up, deviceId: "phone", counter: 0n, key: KEY };

    assert.throws(() => sealFrame(PING, { ...params, salt: SALT.subarray(0, 15) }), RangeError);
  });

  it("rejects a counter outside 0 to 2^64 - 1", () => {
    assert.throws(() => seal(PING, { counter: -1n }), RangeError);
    assert.throws(() => seal(PING, { counter: 2n ** 64n }), RangeError);
  });

  it("rejects a key that is not 32 bytes", () => {
    const params = { direction: Direction.Up, deviceId: "phone", salt: SALT, counter: 0n };

    assert.throws(() => sealFrame(PING, { ...params, key: KEY.subarray(0, 16) }), RangeError);
  });
});
