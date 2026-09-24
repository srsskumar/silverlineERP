/// <reference types="node" />
/**
 * Pure display/validation rules behind the Approvals screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approvalStatusTone,
  formatDocumentType,
  validateApprovalDecision,
} from "../src/approvalsFormat";

describe("formatDocumentType", () => {
  it("uses the house label for a known approval document type", () => {
    assert.equal(formatDocumentType("EXPENSE_CLAIM"), "Expense claim");
    assert.equal(formatDocumentType("PURCHASE_REQUISITION"), "Purchase requisition");
    assert.equal(formatDocumentType("RA_BILL"), "RA bill");
  });

  it("title-cases an unrecognised type instead of failing", () => {
    assert.equal(formatDocumentType("SOME_NEW_DOCUMENT"), "Some new document");
  });
});

describe("approvalStatusTone", () => {
  it("colours the statuses the ladder actually produces, matching web's shared map (fix round 1, item 7)", () => {
    assert.equal(approvalStatusTone("APPROVED"), "success");
    assert.equal(approvalStatusTone("PENDING"), "warning");
    assert.equal(approvalStatusTone("REJECTED"), "danger");
    assert.equal(approvalStatusTone("RECALLED"), "danger");
    // Used to read danger here; web reads SUPERSEDED as info for every
    // document type, and that is the shared value now.
    assert.equal(approvalStatusTone("SUPERSEDED"), "info");
    assert.equal(approvalStatusTone("WHATEVER"), "neutral");
  });
});

describe("validateApprovalDecision", () => {
  it("mirrors the server: REJECT needs a reason, APPROVE does not", () => {
    assert.equal(validateApprovalDecision("REJECT", "").ok, false);
    assert.equal(validateApprovalDecision("REJECT", "   ").ok, false);
    assert.equal(validateApprovalDecision("REJECT", "Rate too high").ok, true);
    assert.equal(validateApprovalDecision("APPROVE", "").ok, true);
  });
});
