/// <reference types="node" />
/**
 * Pure display rules behind the Procurement screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { poStatusTone, requisitionCanSubmit, requisitionStatusTone } from "../src/procurementFormat";

describe("requisitionStatusTone", () => {
  it("colours every PR_STATUSES value, matching web's financialTone (mobile-parity sweep, R5 item 4)", () => {
    assert.equal(requisitionStatusTone("APPROVED"), "success");
    // CONVERTED used to read success here (a requisition already raised into
    // a PO looked the same "done" green as an approved one); web's generic
    // financialTone colours CONVERTED info, and that is what is kept now.
    assert.equal(requisitionStatusTone("CONVERTED"), "info");
    assert.equal(requisitionStatusTone("SUBMITTED"), "warning");
    assert.equal(requisitionStatusTone("REJECTED"), "danger");
    assert.equal(requisitionStatusTone("CANCELLED"), "danger");
    // DRAFT used to read info (blue) here; web's financialTone has no case
    // for it and shows neutral grey, which is now the shared value.
    assert.equal(requisitionStatusTone("DRAFT"), "neutral");
  });
});

describe("poStatusTone", () => {
  it("colours every PO_STATUSES value, matching web's financialTone (mobile-parity sweep, R5 item 4)", () => {
    assert.equal(poStatusTone("FULLY_RECEIVED"), "success");
    assert.equal(poStatusTone("CLOSED"), "success");
    assert.equal(poStatusTone("PARTIALLY_RECEIVED"), "warning");
    // SENT used to read warning here; web's financialTone colours it info.
    assert.equal(poStatusTone("SENT"), "info");
    // APPROVED used to read warning here -- an approved order looked the
    // same still-pending amber as one waiting for approval. Web's
    // financialTone colours APPROVED success, and that is kept now.
    assert.equal(poStatusTone("APPROVED"), "success");
    assert.equal(poStatusTone("CANCELLED"), "danger");
    // DRAFT/PENDING_APPROVAL used to both read info here; web distinguishes
    // them (neutral vs warning) and that distinction is kept now.
    assert.equal(poStatusTone("DRAFT"), "neutral");
    assert.equal(poStatusTone("PENDING_APPROVAL"), "warning");
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
