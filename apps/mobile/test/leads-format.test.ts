/// <reference types="node" />
/**
 * Pure display/validation rules behind the Pipeline (leads) screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatLeadSource,
  formatLeadStage,
  leadStageTone,
  validateLeadCreate,
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

describe("formatLeadSource", () => {
  it("labels every source and falls back for anything unrecognised", () => {
    assert.equal(formatLeadSource("PORTAL_WATCH"), "Portal watch");
    assert.equal(formatLeadSource("SOMETHING_NEW"), "SOMETHING_NEW");
  });
});

describe("validateLeadCreate (B-011)", () => {
  const valid = {
    lead_no: "LD-0001",
    organization_name: "Acme Infra",
    lead_type: "PRIVATE",
    source: "REFERRAL",
  };

  it("accepts a lead with every required field set", () => {
    assert.equal(validateLeadCreate(valid).ok, true);
  });

  it("rejects a blank lead number, and one over 50 characters", () => {
    assert.deepEqual(validateLeadCreate({ ...valid, lead_no: "  " }).errors, [
      { field: "lead_no", message: "A lead number is required" },
    ]);
    assert.equal(validateLeadCreate({ ...valid, lead_no: "L".repeat(51) }).ok, false);
  });

  it("rejects a blank organisation name", () => {
    assert.deepEqual(validateLeadCreate({ ...valid, organization_name: " " }).errors, [
      { field: "organization_name", message: "Organisation name is required" },
    ]);
  });

  it("rejects a lead_type outside CLIENT_TYPES (GOVERNMENT/PRIVATE)", () => {
    assert.equal(validateLeadCreate({ ...valid, lead_type: "NGO" }).ok, false);
  });

  it("rejects a source outside the server's enum", () => {
    assert.equal(validateLeadCreate({ ...valid, source: "CARRIER_PIGEON" }).ok, false);
  });

  it("reports every failing field at once, not just the first", () => {
    const { ok, errors } = validateLeadCreate({
      lead_no: "",
      organization_name: "",
      lead_type: "",
      source: "",
    });
    assert.equal(ok, false);
    assert.equal(errors.length, 4);
  });
});

describe("validateLeadCreate estimated value (MA-008)", () => {
  const valid = { lead_no: "LD-1", organization_name: "Acme", lead_type: "PRIVATE", source: "OTHER" };
  it("refuses a value that is not a non-negative number (the API only says Invalid input)", () => {
    assert.equal(validateLeadCreate({ ...valid, estimated_value: "abc" }).ok, false);
    assert.equal(validateLeadCreate({ ...valid, estimated_value: "-5" }).ok, false);
  });
  it("accepts a blank or numeric value", () => {
    assert.equal(validateLeadCreate({ ...valid, estimated_value: "" }).ok, true);
    assert.equal(validateLeadCreate({ ...valid, estimated_value: "1500.50" }).ok, true);
  });
});
