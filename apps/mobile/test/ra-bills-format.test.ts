/// <reference types="node" />
/**
 * Pure display rules behind the Project finance (RA bills) screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { raBillAmount, raBillOverdue, raBillStatusTone } from "../src/raBillsFormat";

describe("raBillStatusTone", () => {
  it("colours every RA_BILL_STATUSES value", () => {
    assert.equal(raBillStatusTone("CERTIFIED"), "success");
    assert.equal(raBillStatusTone("PAID"), "success");
    assert.equal(raBillStatusTone("SUBMITTED"), "warning");
    assert.equal(raBillStatusTone("CANCELLED"), "danger");
    assert.equal(raBillStatusTone("DRAFT"), "info");
  });
});

describe("raBillAmount", () => {
  it("uses the certified amount once one is recorded", () => {
    assert.equal(raBillAmount({ certified_amount: 90000, net_payable: 100000 }), 90000);
  });

  it("falls back to the claimed net payable before certification", () => {
    assert.equal(raBillAmount({ certified_amount: null, net_payable: 100000 }), 100000);
    assert.equal(raBillAmount({ net_payable: "50000" }), 50000);
  });
});

describe("raBillOverdue", () => {
  it("flags a certified bill past its due date", () => {
    assert.equal(raBillOverdue({ status: "CERTIFIED", due_date: "2026-01-01" }, "2026-02-01"), true);
  });

  it("does not flag a bill that is not yet due", () => {
    assert.equal(raBillOverdue({ status: "CERTIFIED", due_date: "2026-03-01" }, "2026-02-01"), false);
  });

  it("does not flag a bill still in draft, or one with no due date", () => {
    assert.equal(raBillOverdue({ status: "DRAFT", due_date: "2026-01-01" }, "2026-02-01"), false);
    assert.equal(raBillOverdue({ status: "CERTIFIED", due_date: null }, "2026-02-01"), false);
  });
});
