/// <reference types="node" />
/**
 * Pure validation/display rules behind the Expenses screen's receipts
 * section (B-003).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_RECEIPT_EXTENSIONS, ALLOWED_RECEIPT_MIME_TYPES, MAX_RECEIPT_BYTES, MAX_RECEIPTS_PER_CLAIM,
  canAddReceipt, checkReceiptFile, claimTakesReceipts, formatReceiptSize,
  receiptExtension, receiptIcon, safeReceiptFileName,
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

  it("ignores mime type when the picker/camera didn't report one", () => {
    assert.equal(checkReceiptFile("bill.png", 1000, undefined).ok, true);
    assert.equal(checkReceiptFile("bill.png", 1000, null).ok, true);
  });

  it("accepts a mime type that matches its extension", () => {
    assert.equal(checkReceiptFile("bill.png", 1000, "image/png").ok, true);
    assert.equal(checkReceiptFile("bill.jpg", 1000, "image/jpeg").ok, true);
    assert.equal(checkReceiptFile("bill.jpeg", 1000, "image/jpeg").ok, true);
    assert.equal(checkReceiptFile("bill.pdf", 1000, "application/pdf").ok, true);
  });

  it("allow-lists exactly the three mime types the API accepts", () => {
    assert.deepEqual(
      [...ALLOWED_RECEIPT_MIME_TYPES].sort(),
      ["application/pdf", "image/jpeg", "image/png"],
    );
  });

  it("refuses a mime type outside the allow-list even with an allowed extension", () => {
    const r = checkReceiptFile("bill.png", 1000, "application/zip");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /isn't supported/);
  });

  it("refuses a mime type that doesn't match the file's extension", () => {
    const r = checkReceiptFile("bill.png", 1000, "application/pdf");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /match/);
  });
});

describe("safeReceiptFileName", () => {
  it("keeps an already-clean name as is", () => {
    assert.equal(safeReceiptFileName("taxi-bill.png"), "taxi-bill.png");
  });

  it("strips a unix-style path down to the last segment", () => {
    assert.equal(safeReceiptFileName("/data/user/0/com.app/cache/scan.pdf"), "scan.pdf");
  });

  it("strips a windows-style path down to the last segment", () => {
    assert.equal(safeReceiptFileName("C:\\Users\\me\\Downloads\\scan.pdf"), "scan.pdf");
  });

  it("strips control characters and trims whitespace", () => {
    assert.equal(safeReceiptFileName("  bad\u0000name\u0007.png\n"), "badname.png");
  });

  it("falls back to a generic name when nothing usable remains", () => {
    assert.equal(safeReceiptFileName("\u0000\u0001"), "receipt");
  });

  it("caps an overlong name while keeping its extension", () => {
    const long = `${"a".repeat(300)}.png`;
    const result = safeReceiptFileName(long);
    assert.ok(result.length <= 120);
    assert.match(result, /\.png$/);
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
