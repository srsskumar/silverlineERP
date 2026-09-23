/// <reference types="node" />
/**
 * Pure display rules behind the Procurement screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { poStatusTone, requisitionCanSubmit, requisitionStatusTone } from "../src/procurementFormat";

describe("requisitionStatusTone", () => {
  it("colours every PR_STATUSES value", () => {
    assert.equal(requisitionStatusTone("APPROVED"), "success");
    assert.equal(requisitionStatusTone("CONVERTED"), "success");
    assert.equal(requisitionStatusTone("SUBMITTED"), "warning");
    assert.equal(requisitionStatusTone("REJECTED"), "danger");
    assert.equal(requisitionStatusTone("CANCELLED"), "danger");
    assert.equal(requisitionStatusTone("DRAFT"), "info");
  });
});

describe("poStatusTone", () => {
  it("colours every PO_STATUSES value", () => {
    assert.equal(poStatusTone("FULLY_RECEIVED"), "success");
    assert.equal(poStatusTone("CLOSED"), "success");
    assert.equal(poStatusTone("PARTIALLY_RECEIVED"), "warning");
    assert.equal(poStatusTone("SENT"), "warning");
    assert.equal(poStatusTone("APPROVED"), "warning");
    assert.equal(poStatusTone("CANCELLED"), "danger");
    assert.equal(poStatusTone("DRAFT"), "info");
    assert.equal(poStatusTone("PENDING_APPROVAL"), "info");
  });
});

describe("requisitionCanSubmit", () => {
  it("allows (re)submitting only from DRAFT or REJECTED", () => {
    assert.equal(requisitionCanSubmit("DRAFT"), true);
    assert.equal(requisitionCanSubmit("REJECTED"), true);
    assert.equal(requisitionCanSubmit("SUBMITTED"), false);
    assert.equal(requisitionCanSubmit("APPROVED"), false);
    assert.equal(requisitionCanSubmit("CONVERTED"), false);
  });
});
