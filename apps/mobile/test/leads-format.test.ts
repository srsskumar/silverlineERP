/// <reference types="node" />
/**
 * Pure display/validation rules behind the Pipeline (leads) screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatLeadStage,
  leadStageTone,
  validateLeadStageChange,
} from "../src/leadsFormat";

describe("formatLeadStage", () => {
  it("labels every stage in LEAD_STAGES", () => {
    assert.equal(formatLeadStage("NEW"), "New");
    assert.equal(formatLeadStage("TENDER_IDENTIFIED"), "Tender identified");
    assert.equal(formatLeadStage("DISQUALIFIED"), "Disqualified");
  });

  it("falls back to the raw code for anything unrecognised", () => {
    assert.equal(formatLeadStage("SOMETHING_NEW"), "SOMETHING_NEW");
  });
});

describe("leadStageTone", () => {
  it("colours the terminal stages and leaves the rest informational", () => {
    assert.equal(leadStageTone("CONVERTED"), "success");
    assert.equal(leadStageTone("LOST"), "danger");
    assert.equal(leadStageTone("DISQUALIFIED"), "danger");
    assert.equal(leadStageTone("NEW"), "neutral");
    assert.equal(leadStageTone("QUALIFIED"), "info");
  });
});

describe("validateLeadStageChange", () => {
  it("mirrors the server: LOST/DISQUALIFIED need a reason, everything else does not", () => {
    assert.equal(validateLeadStageChange("LOST", "").ok, false);
    assert.equal(validateLeadStageChange("LOST", "   ").ok, false);
    assert.equal(validateLeadStageChange("DISQUALIFIED", "").ok, false);
    assert.equal(validateLeadStageChange("LOST", "Budget cut").ok, true);
    assert.equal(validateLeadStageChange("QUALIFIED", "").ok, true);
    assert.equal(validateLeadStageChange("CONTACTED", "").ok, true);
  });
});
