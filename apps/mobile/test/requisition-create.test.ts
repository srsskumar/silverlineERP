/// <reference types="node" />
/**
 * validateRequisitionCreate (src/validators.ts) — the cheap client-side
 * pre-check mirroring shared requisitionSchema's single-line shape mobile
 * raises.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRequisitionCreate } from "../src/validators";

function valid(overrides: Partial<Parameters<typeof validateRequisitionCreate>[0]> = {}) {
  return validateRequisitionCreate({
    requisition_no: "PR-001",
    justification: "Site needs cement",
    description: "Cement OPC 53",
    unit: "bag",
    quantity: 50,
    ...overrides,
  });
}

describe("validateRequisitionCreate", () => {
  it("accepts a well-formed single-line requisition", () => {
    assert.equal(valid().ok, true);
  });

  it("rejects a missing requisition number", () => {
    const r = valid({ requisition_no: "" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === "requisition_no"));
  });

  it("rejects a requisition number over 50 characters", () => {
    const r = valid({ requisition_no: "x".repeat(51) });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === "requisition_no"));
  });

  it("rejects a missing justification", () => {
    const r = valid({ justification: "" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === "justification"));
  });

  it("rejects a missing description or unit", () => {
    assert.equal(valid({ description: "" }).ok, false);
    assert.equal(valid({ unit: "" }).ok, false);
  });

  it("rejects a zero or negative quantity", () => {
    assert.equal(valid({ quantity: 0 }).ok, false);
    assert.equal(valid({ quantity: -5 }).ok, false);
    assert.equal(valid({ quantity: "not-a-number" }).ok, false);
  });
});
