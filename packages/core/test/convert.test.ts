import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeRef, encodeRef, prepareContent, wireBlobToBlob } from "../src/convert.ts";
import type { RoomLocation } from "../src/convert.ts";
import type { WireBlob } from "../src/protocol.ts";
import type { Sendable } from "../src/types.ts";

const LOCATION: RoomLocation = {
  device: "phone",
  appInstance: "com.kakao.talk/0",
  room: "4794483397574872",
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
        device: `d${index}`,
        appInstance: `계정${index}`,
        room: `?>${index}`,
      });

      assert.match(ref, /^[A-Za-z0-9_-]+$/);
    }
  });

  it("gives different refs for different rooms", () => {
    const refs = new Set([
      encodeRef(LOCATION),
      encodeRef({ ...LOCATION, device: "tablet" }),
      encodeRef({ ...LOCATION, appInstance: "com.kakao.talk/10" }),
      encodeRef({ ...LOCATION, room: "1" }),
      encodeRef({ device: "a", appInstance: "bc", room: "d" }),
      encodeRef({ device: "ab", appInstance: "c", room: "d" }),
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
      { device: "폰 📱", appInstance: "계정/0", room: "방" },
      { device: 'with "quotes"', appInstance: "a,b", room: "]" },
      { device: "", appInstance: "", room: "" },
      { device: "x".repeat(300), appInstance: "\n\t", room: "\u0000" },
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

const BYTES = new Uint8Array([0, 1, 2, 250, 251, 255]);
const BASE64 = Buffer.from(BYTES).toString("base64");

async function bytesOf(blob: Blob | undefined): Promise<number[]> {
  return Array.from(new Uint8Array(await blob!.arrayBuffer()));
}

describe("wireBlobToBlob", () => {
  it("turns base64 data and its type into a Blob", async () => {
    const blob = wireBlobToBlob({ mime: "image/png", base64: BASE64 });

    assert.equal(blob?.type, "image/png");
    assert.deepEqual(await bytesOf(blob), Array.from(BYTES));
  });

  it("returns undefined when there is no data", () => {
    assert.equal(wireBlobToBlob(undefined), undefined);
  });
});

describe("prepareContent, text", () => {
  it("accepts a string and an object with text", async () => {
    const expected = { content: { text: "안녕" }, required: ["room.send"] };

    assert.deepEqual(await prepareContent("안녕"), expected);
    assert.deepEqual(await prepareContent({ text: "안녕" }), expected);
  });

  it("refuses empty text", async () => {
    await assert.rejects(prepareContent(""), TypeError);
    await assert.rejects(prepareContent({ text: "" }), TypeError);
    await assert.rejects(prepareContent({ text: 1 } as unknown as Sendable), TypeError);
  });
});

describe("prepareContent, image", () => {
  it("encodes bytes, which have no type", async () => {
    const prepared = await prepareContent({ image: BYTES });

    assert.deepEqual(prepared, {
      content: { image: { mime: "application/octet-stream", base64: BASE64 } },
      required: ["room.send", "send.image"],
    });
    assert.equal("caption" in prepared.content, false);
  });

  it("keeps the caption", async () => {
    const prepared = await prepareContent({ image: BYTES, caption: "look" });

    assert.equal("caption" in prepared.content && prepared.content.caption, "look");
  });

  it("takes the type of a Blob, or falls back when it has none", async () => {
    const typed = await prepareContent({ image: new Blob([BYTES], { type: "image/jpeg" }) });
    const untyped = await prepareContent({ image: new Blob([BYTES]) });

    assert.deepEqual("image" in typed.content && typed.content.image, {
      mime: "image/jpeg",
      base64: BASE64,
    });
    assert.equal(
      "image" in untyped.content && untyped.content.image.mime,
      "application/octet-stream",
    );
  });

  it("encodes only the bytes that a view covers", async () => {
    const larger = new Uint8Array([9, 9, ...BYTES, 9]);
    const prepared = await prepareContent({ image: larger.subarray(2, 2 + BYTES.length) });

    assert.equal("image" in prepared.content && prepared.content.image.base64, BASE64);
  });

  it("can be turned back into the same bytes", async () => {
    const prepared = await prepareContent({ image: new Blob([BYTES], { type: "image/png" }) });
    const wire = "image" in prepared.content ? (prepared.content.image as WireBlob) : undefined;
    const blob = wireBlobToBlob(wire);

    assert.equal(blob?.type, "image/png");
    assert.deepEqual(await bytesOf(blob), Array.from(BYTES));
  });
});

describe("prepareContent, file", () => {
  it("encodes the data and keeps the name", async () => {
    assert.deepEqual(await prepareContent({ file: BYTES, name: "a.bin" }), {
      content: { file: { mime: "application/octet-stream", base64: BASE64 }, name: "a.bin" },
      required: ["room.send", "send.file"],
    });
  });

  it("refuses a file without a name", async () => {
    await assert.rejects(prepareContent({ file: BYTES, name: "" }), TypeError);
    await assert.rejects(prepareContent({ file: BYTES } as unknown as Sendable), TypeError);
  });
});

describe("prepareContent, invalid content", () => {
  it("refuses what is not text, an image or a file", async () => {
    for (const value of [{}, 42, null, undefined, true, []]) {
      await assert.rejects(prepareContent(value as unknown as Sendable), TypeError);
    }
  });

  it("refuses an object that has more than one of text, image and file", async () => {
    const both = { text: "a", image: BYTES } as unknown as Sendable;

    await assert.rejects(prepareContent(both), TypeError);
  });
});
