/// <reference types="node" />
/**
 * tenderStatusTone (src/tendersFormat.ts) — the badge colour for a tender's
 * status, mirroring apps/web/app/tenders/page.tsx's own statusTone().
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tenderStatusTone, validateTenderCreate } from "../src/tendersFormat";

describe("tenderStatusTone", () => {
  it("colours each status TENDER_STATUS_TRANSITIONS can produce", () => {
    assert.equal(tenderStatusTone("AWARDED"), "success");
    assert.equal(tenderStatusTone("REJECTED"), "danger");
    assert.equal(tenderStatusTone("CANCELLED"), "danger");
    assert.equal(tenderStatusTone("SUBMITTED"), "info");
    assert.equal(tenderStatusTone("UNDER_EVALUATION"), "info");
    assert.equal(tenderStatusTone("SELECTED"), "warning");
    assert.equal(tenderStatusTone("DRAFT"), "neutral");
    assert.equal(tenderStatusTone("PUBLISHED"), "neutral");
  });
});

describe("validateTenderCreate (B-011 follow-on)", () => {
  it("accepts a tender number and a valid tender_type", () => {
    assert.equal(validateTenderCreate({ tender_no: "TN-0001", tender_type: "OPEN" }).ok, true);
  });

  it("rejects a blank tender number", () => {
    const { ok, errors } = validateTenderCreate({ tender_no: " ", tender_type: "OPEN" });
    assert.equal(ok, false);
    assert.deepEqual(errors, [{ field: "tender_no", message: "A tender number is required" }]);
  });

  it("rejects a tender_type outside the server's enum", () => {
    assert.equal(validateTenderCreate({ tender_no: "TN-1", tender_type: "SEALED_BID" }).ok, false);
  });
});
