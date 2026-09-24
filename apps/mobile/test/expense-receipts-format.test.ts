/// <reference types="node" />
/**
 * Pure validation/display rules behind the Expenses screen's receipts
 * section (B-003).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_RECEIPT_EXTENSIONS, MAX_RECEIPT_BYTES, MAX_RECEIPTS_PER_CLAIM,
  canAddReceipt, checkReceiptFile, claimTakesReceipts, formatReceiptSize,
  receiptExtension, receiptIcon,
} from "../src/expenseReceiptsFormat";

describe("receiptExtension", () => {
  it("lowercases whatever follows the last dot", () => {
    assert.equal(receiptExtension("taxi-bill.PNG"), "png");
    assert.equal(receiptExtension("scan.PDF"), "pdf");
  });

  it("is empty for a name with no extension", () => {
    assert.equal(receiptExtension("noextension"), "");
    assert.equal(receiptExtension("trailing."), "");
  });
});

describe("claimTakesReceipts", () => {
  it("takes receipts only from DRAFT or SUBMITTED", () => {
    assert.equal(claimTakesReceipts("DRAFT"), true);
    assert.equal(claimTakesReceipts("SUBMITTED"), true);
    assert.equal(claimTakesReceipts("APPROVED"), false);
    assert.equal(claimTakesReceipts("REJECTED"), false);
    assert.equal(claimTakesReceipts("REIMBURSED"), false);
  });
});

describe("checkReceiptFile", () => {
  it("accepts every allowed extension", () => {
    for (const ext of ALLOWED_RECEIPT_EXTENSIONS) {
      assert.equal(checkReceiptFile(`bill.${ext}`, 1000).ok, true);
    }
  });

  it("refuses an extension outside the allow-list", () => {
    const r = checkReceiptFile("bill.gif", 1000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /pdf, jpg, jpeg, png/);
  });

  it("refuses a file over the 10MB limit", () => {
    const r = checkReceiptFile("bill.png", MAX_RECEIPT_BYTES + 1);
    assert.equal(r.ok, false);
  });

  it("accepts a file right at the limit", () => {
    assert.equal(checkReceiptFile("bill.png", MAX_RECEIPT_BYTES).ok, true);
  });
});

describe("canAddReceipt", () => {
  it("refuses once the claim is no longer editable", () => {
    const r = canAddReceipt("APPROVED", 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /approved claim/);
  });

  it(`refuses a ${MAX_RECEIPTS_PER_CLAIM + 1}th receipt`, () => {
    const r = canAddReceipt("DRAFT", MAX_RECEIPTS_PER_CLAIM);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, new RegExp(`at most ${MAX_RECEIPTS_PER_CLAIM}`));
  });

  it("allows the claim's fifth receipt, just not its sixth", () => {
    assert.equal(canAddReceipt("SUBMITTED", MAX_RECEIPTS_PER_CLAIM - 1).ok, true);
    assert.equal(canAddReceipt("SUBMITTED", MAX_RECEIPTS_PER_CLAIM).ok, false);
  });
});

describe("formatReceiptSize", () => {
  it("uses bytes, KB and MB at the right thresholds", () => {
    assert.equal(formatReceiptSize(850), "850 B");
    assert.equal(formatReceiptSize(12_400), "12.1 KB");
    assert.equal(formatReceiptSize(3_400_000), "3.2 MB");
  });
});

describe("receiptIcon", () => {
  it("gives a PDF a document icon and anything else an image icon", () => {
    assert.equal(receiptIcon("application/pdf"), "document-text-outline");
    assert.equal(receiptIcon("image/jpeg"), "image-outline");
    assert.equal(receiptIcon(null), "image-outline");
  });
});
