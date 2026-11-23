import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeRef, encodeRef } from "../src/convert.ts";
import type { RoomLocation } from "../src/convert.ts";

const LOCATION: RoomLocation = {
  deviceId: "phone",
  accountId: "com.kakao.talk/0",
  roomId: "4794483397574872",
};

/** Encodes `value` as the text that `decodeRef` reads, to build refs that `encodeRef` never makes. */
function encodeText(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

describe("encodeRef", () => {
  // Fixed vector: a saved ref has to keep working, so the format must not change.
  it("encodes the known ref", () => {
    assert.equal(
      encodeRef(LOCATION),
      "WyJwaG9uZSIsImNvbS5rYWthby50YWxrLzAiLCI0Nzk0NDgzMzk3NTc0ODcyIl0",
    );
  });

  it("uses only URL-safe characters", () => {
    for (let index = 0; index < 500; index++) {
      const ref = encodeRef({
        deviceId: `d${index}`,
        accountId: `계정${index}`,
        roomId: `?>${index}`,
      });

      assert.match(ref, /^[A-Za-z0-9_-]+$/);
    }
  });

  it("gives different refs for different rooms", () => {
    const refs = new Set([
      encodeRef(LOCATION),
      encodeRef({ ...LOCATION, deviceId: "tablet" }),
      encodeRef({ ...LOCATION, accountId: "com.kakao.talk/10" }),
      encodeRef({ ...LOCATION, roomId: "1" }),
      encodeRef({ deviceId: "a", accountId: "bc", roomId: "d" }),
      encodeRef({ deviceId: "ab", accountId: "c", roomId: "d" }),
    ]);

    assert.equal(refs.size, 6);
  });
});

describe("decodeRef", () => {
  it("reads back the ids that encodeRef was given", () => {
    assert.deepEqual(decodeRef(encodeRef(LOCATION)), LOCATION);
  });

  it("reads back ids with any characters", () => {
    const locations: RoomLocation[] = [
      { deviceId: "폰 📱", accountId: "계정/0", roomId: "방" },
      { deviceId: 'with "quotes"', accountId: "a,b", roomId: "]" },
      { deviceId: "", accountId: "", roomId: "" },
      { deviceId: "x".repeat(300), accountId: "\n\t", roomId: "\u0000" },
    ];

    for (const location of locations) {
      assert.deepEqual(decodeRef(encodeRef(location)), location);
    }
  });

  it("refuses text that is not a ref", () => {
    for (const ref of ["", "ref", "!!!!", "WyJwaG9uZSIs", encodeRef(LOCATION).slice(0, -3)]) {
      assert.equal(decodeRef(ref), undefined, ref);
    }
  });

  it("refuses JSON that is not a list of three ids", () => {
    const values = ['"phone"', "{}", "null", "42", '["a","b"]', '["a","b","c","d"]', '["a","b",3]'];

    for (const value of values) {
      assert.equal(decodeRef(encodeText(value)), undefined, value);
    }
  });

  it("refuses a ref that is written in another way than encodeRef writes it", () => {
    const ref = encodeRef(LOCATION);
    const standard = Buffer.from(ref, "base64url").toString("base64");

    assert.equal(decodeRef(`${ref}=`), undefined);
    assert.equal(decodeRef(` ${ref}`), undefined);
    assert.equal(decodeRef(`${ref}\n`), undefined);
    assert.equal(decodeRef(ref.slice(0, 10) + "$" + ref.slice(10)), undefined);
    assert.equal(
      decodeRef(encodeText('[ "phone","com.kakao.talk/0","4794483397574872"]')),
      undefined,
    );
    assert.notEqual(standard, ref);
    assert.equal(decodeRef(standard), undefined);
  });
});
