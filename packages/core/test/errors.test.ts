import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RKErrorCode } from "../src/errors.ts";
import { isRKError, RKError } from "../src/errors.ts";
import type { Device } from "../src/types.ts";

const DEFAULT_RETRYABLE: Record<RKErrorCode, boolean> = {
  TIMEOUT: true,
  DEVICE_OFFLINE: true,
  UNREACHABLE: true,
  ABORTED: false,
  CLOSED: false,
  UNSUPPORTED: false,
  NOT_FOUND: false,
  REJECTED: false,
  CLIENT_ERROR: false,
  AUTH_FAILED: false,
  PROTOCOL_MISMATCH: false,
  PROTOCOL_ERROR: false,
};

describe("RKError", () => {
  it("is an Error with its code and message", () => {
    const error = new RKError("NOT_FOUND", "no such room");

    assert.ok(error instanceof Error);
    assert.ok(error instanceof RKError);
    assert.equal(error.name, "RKError");
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(error.message, "no such room");
  });

  describe("retryable", () => {
    for (const [code, expected] of Object.entries(DEFAULT_RETRYABLE) as [RKErrorCode, boolean][]) {
      it(`defaults to ${expected} for ${code}`, () => {
        assert.equal(new RKError(code, "x").retryable, expected);
      });
    }

    it("can be overridden in both directions", () => {
      assert.equal(new RKError("TIMEOUT", "x", { retryable: false }).retryable, false);
      assert.equal(new RKError("CLOSED", "x", { retryable: true }).retryable, true);
    });
  });

  describe("cause", () => {
    it("keeps the given cause", () => {
      const cause = new Error("root");

      assert.equal(new RKError("CLIENT_ERROR", "x", { cause }).cause, cause);
    });

    it("keeps a falsy cause that is not undefined", () => {
      assert.equal(new RKError("ABORTED", "x", { cause: null }).cause, null);
      assert.equal(new RKError("ABORTED", "x", { cause: 0 }).cause, 0);
    });

    it("has no cause property when none is given", () => {
      assert.equal("cause" in new RKError("ABORTED", "x"), false);
    });
  });

  describe("device", () => {
    it("keeps the given device", () => {
      const device = { id: "phone" } as Device;

      assert.equal(new RKError("DEVICE_OFFLINE", "x", { device }).device, device);
    });

    it("is undefined when none is given", () => {
      assert.equal(new RKError("DEVICE_OFFLINE", "x").device, undefined);
    });
  });
});

describe("isRKError", () => {
  const error = new RKError("TIMEOUT", "x");

  it("accepts an RKError", () => {
    assert.equal(isRKError(error), true);
  });

  it("matches only the given code", () => {
    assert.equal(isRKError(error, "TIMEOUT"), true);
    assert.equal(isRKError(error, "CLOSED"), false);
  });

  it("rejects anything that is not an RKError", () => {
    assert.equal(isRKError(new Error("x")), false);
    assert.equal(isRKError({ name: "RKError", code: "TIMEOUT" }), false);
    assert.equal(isRKError("TIMEOUT"), false);
    assert.equal(isRKError(null), false);
    assert.equal(isRKError(undefined), false);
  });

  it("narrows the type", () => {
    const unknownError: unknown = error;

    if (isRKError(unknownError)) {
      const code: RKErrorCode = unknownError.code;
      assert.equal(code, "TIMEOUT");
    } else {
      assert.fail("expected an RKError");
    }
  });
});
