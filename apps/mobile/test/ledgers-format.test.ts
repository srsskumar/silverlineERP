/// <reference types="node" />
/**
 * Pure display rules shared by the Receivables and Payables screens.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGEING_BUCKET_LABELS, oldestBucket, partyTone, paymentRunTone } from "../src/ledgersFormat";

const buckets = { NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0 };

describe("partyTone", () => {
  it("is neutral with nothing overdue", () => {
    assert.equal(partyTone({ overdue: 0, total: 1000 }), "neutral");
  });

  it("is warning when overdue is a minority of the total", () => {
    assert.equal(partyTone({ overdue: 200, total: 1000 }), "warning");
  });

  it("is danger when overdue is half or more of the total", () => {
    assert.equal(partyTone({ overdue: 600, total: 1000 }), "danger");
    assert.equal(partyTone({ overdue: 500, total: 1000 }), "danger");
  });
});

describe("oldestBucket", () => {
  it("returns null when nothing is aged", () => {
    assert.equal(oldestBucket(buckets), null);
  });

  it("returns the oldest non-empty bucket, not the first", () => {
    assert.equal(oldestBucket({ ...buckets, D1_30: 100, OVER_90: 50 }), "OVER_90");
  });

  it("ignores dust below the rounding threshold", () => {
    assert.equal(oldestBucket({ ...buckets, D31_60: 0.001 }), null);
  });
});

describe("AGEING_BUCKET_LABELS", () => {
  it("has a human label for every bucket key", () => {
    for (const key of Object.keys(buckets)) {
      assert.equal(typeof AGEING_BUCKET_LABELS[key as keyof typeof buckets], "string");
    }
  });
});

describe("paymentRunTone (B-002)", () => {
  it("reads PAID the same as APPROVED — both mean the money is settled", () => {
    assert.equal(paymentRunTone("PAID"), "success");
    assert.equal(paymentRunTone("APPROVED"), "success");
  });

  it("is neutral once cancelled and warning while still a draft", () => {
    assert.equal(paymentRunTone("CANCELLED"), "neutral");
    assert.equal(paymentRunTone("DRAFT"), "warning");
  });
});
