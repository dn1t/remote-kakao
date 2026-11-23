import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { deriveKey, Direction } from "../src/seal.ts";

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
