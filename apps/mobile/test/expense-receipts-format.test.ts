/// <reference types="node" />
/**
 * Pure validation/display rules behind the Expenses screen's receipts
 * section (B-003).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_RECEIPT_EXTENSIONS, ALLOWED_RECEIPT_MIME_TYPES, MAX_RECEIPT_BYTES, MAX_RECEIPTS_PER_CLAIM,
  base64ByteLength, canAddReceipt, canFallBackToReadingForSize, checkReceiptFile, claimTakesReceipts,
  formatReceiptSize, receiptExtension, receiptIcon, reconcileReceiptFileName, safeReceiptFileName,
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

describe("reconcileReceiptFileName", () => {
  it("leaves a name whose extension already agrees with its mime type", () => {
    assert.equal(reconcileReceiptFileName("bill.png", "image/png"), "bill.png");
    assert.equal(reconcileReceiptFileName("scan.pdf", "application/pdf"), "scan.pdf");
  });

  it("treats .jpg and .jpeg as both already agreeing with image/jpeg", () => {
    assert.equal(reconcileReceiptFileName("bill.jpg", "image/jpeg"), "bill.jpg");
    assert.equal(reconcileReceiptFileName("bill.jpeg", "image/jpeg"), "bill.jpeg");
  });

  it("renames a HEIC-origin photo the gallery picker re-encoded to JPEG", () => {
    assert.equal(reconcileReceiptFileName("IMG_1234.HEIC", "image/jpeg"), "IMG_1234.jpg");
  });

  it("renames a PNG-origin photo re-encoded to JPEG the same way", () => {
    assert.equal(reconcileReceiptFileName("photo.png", "image/jpeg"), "photo.jpg");
  });

  it("appends the mime type's extension when the name has none", () => {
    assert.equal(reconcileReceiptFileName("scan", "application/pdf"), "scan.pdf");
  });

  it("leaves the name alone when there's no mime type to reconcile against", () => {
    assert.equal(reconcileReceiptFileName("odd-name.xyz", undefined), "odd-name.xyz");
    assert.equal(reconcileReceiptFileName("odd-name.xyz", null), "odd-name.xyz");
  });

  it("leaves the name alone for a mime type it doesn't recognize (checkReceiptFile rejects it later)", () => {
    assert.equal(reconcileReceiptFileName("bill.png", "application/zip"), "bill.png");
  });

  it("still strips path segments and control characters (delegates to safeReceiptFileName)", () => {
    assert.equal(reconcileReceiptFileName("/cache/IMG.HEIC", "image/jpeg"), "IMG.jpg");
  });
});

describe("base64ByteLength", () => {
  it("matches the real decoded length for known base64 strings", () => {
    assert.equal(base64ByteLength(""), 0);
    assert.equal(base64ByteLength(Buffer.from("A").toString("base64")), 1);
    assert.equal(base64ByteLength(Buffer.from("AB").toString("base64")), 2);
    assert.equal(base64ByteLength(Buffer.from("ABC").toString("base64")), 3);
    assert.equal(base64ByteLength(Buffer.from("ABCD").toString("base64")), 4);
  });

  it("ignores embedded whitespace", () => {
    const b64 = Buffer.from("ABCD").toString("base64");
    const withNewlines = `${b64.slice(0, 2)}\n${b64.slice(2)}`;
    assert.equal(base64ByteLength(withNewlines), 4);
  });
});

describe("canFallBackToReadingForSize", () => {
  it("refuses when the picker never reported a size either", () => {
    assert.equal(canFallBackToReadingForSize(undefined).ok, false);
    assert.equal(canFallBackToReadingForSize(null).ok, false);
    assert.equal(canFallBackToReadingForSize(Number.NaN).ok, false);
  });

  it("refuses when the picker's own reported size is already over the limit", () => {
    const r = canFallBackToReadingForSize(MAX_RECEIPT_BYTES + 1);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /10MB limit/);
  });

  it("allows reading when the picker reports a size at or under the limit", () => {
    assert.equal(canFallBackToReadingForSize(1000).ok, true);
    assert.equal(canFallBackToReadingForSize(MAX_RECEIPT_BYTES).ok, true);
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
