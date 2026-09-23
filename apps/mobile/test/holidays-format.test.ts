/// <reference types="node" />
/**
 * Pure display rules behind the Holidays screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { holidayScopeLabel } from "../src/holidaysFormat";

describe("holidayScopeLabel", () => {
  it("is Org-wide with no scope_type", () => {
    assert.equal(holidayScopeLabel({}), "Org-wide");
    assert.equal(holidayScopeLabel({ scope_type: null }), "Org-wide");
  });

  it("names the resolved unit when scope_name is present", () => {
    assert.equal(
      holidayScopeLabel({ scope_type: "district", scope_name: "Krishna" }),
      "Krishna (district)",
    );
  });

  it("falls back to a truncated id when the unit name is unresolved", () => {
    assert.equal(
      holidayScopeLabel({ scope_type: "village", scope_id: "64634e67-aaaa-bbbb-cccc-000000000000" }),
      "village 64634e67…",
    );
  });
});
