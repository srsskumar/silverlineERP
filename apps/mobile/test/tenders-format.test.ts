/// <reference types="node" />
/**
 * tenderStatusTone (src/tendersFormat.ts) — the badge colour for a tender's
 * status, mirroring apps/web/app/tenders/page.tsx's own statusTone().
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tenderStatusTone } from "../src/tendersFormat";

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
