/// <reference types="node" />
/**
 * A mock location never reaches the server as a punch (owner decision
 * 2026-10-28: no mock locations). The phone refuses up front, in words the
 * crew can act on, so the queue is not filled with punches the server will
 * refuse anyway.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mockLocationRefusal } from "../src/attendance/mockGuard";

describe("mockLocationRefusal", () => {
  it("refuses a mocked fix and says how to clear it", () => {
    const why = mockLocationRefusal({ mocked: true });
    assert.ok(why);
    assert.match(why, /mock location/i);
    assert.match(why, /developer options/i);
  });
  it("lets a genuine fix through, and says nothing before there is a fix", () => {
    assert.equal(mockLocationRefusal({ mocked: false }), null);
    assert.equal(mockLocationRefusal(null), null);
  });
});
