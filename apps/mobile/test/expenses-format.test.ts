/// <reference types="node" />
/**
 * Pure display/action rules behind the Expenses screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categoryLabel, expenseClaimActions, expenseStatusTone } from "../src/expensesFormat";

describe("expenseStatusTone", () => {
  it("colours every EXPENSE_CLAIM_STATUSES value", () => {
    assert.equal(expenseStatusTone("APPROVED"), "success");
    assert.equal(expenseStatusTone("REIMBURSED"), "success");
    assert.equal(expenseStatusTone("SUBMITTED"), "warning");
    assert.equal(expenseStatusTone("REJECTED"), "danger");
    assert.equal(expenseStatusTone("WITHDRAWN"), "danger");
    assert.equal(expenseStatusTone("DRAFT"), "info");
  });
});

describe("categoryLabel", () => {
  it("turns a shouting enum value into a readable label", () => {
    assert.equal(categoryLabel("SITE_MATERIALS_PETTY"), "Site Materials Petty");
    assert.equal(categoryLabel("FUEL"), "Fuel");
  });
});

describe("expenseClaimActions", () => {
  it("allows (re)submitting only from DRAFT or REJECTED", () => {
    assert.equal(expenseClaimActions("DRAFT").canSubmit, true);
    assert.equal(expenseClaimActions("REJECTED").canSubmit, true);
    assert.equal(expenseClaimActions("SUBMITTED").canSubmit, false);
    assert.equal(expenseClaimActions("APPROVED").canSubmit, false);
  });

  it("allows withdrawing only from DRAFT or SUBMITTED", () => {
    assert.equal(expenseClaimActions("DRAFT").canWithdraw, true);
    assert.equal(expenseClaimActions("SUBMITTED").canWithdraw, true);
    assert.equal(expenseClaimActions("APPROVED").canWithdraw, false);
    assert.equal(expenseClaimActions("REIMBURSED").canWithdraw, false);
  });
});
