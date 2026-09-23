/// <reference types="node" />
/**
 * Pure display rules behind the Asset movements screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conditionLabel, movementLabel, movementTone } from "../src/assetMovementsFormat";

describe("movementLabel / movementTone", () => {
  it("describes an ISSUED row as going out, in warning", () => {
    assert.equal(movementLabel("ISSUED"), "Went out");
    assert.equal(movementTone("ISSUED"), "warning");
  });

  it("describes a RETURNED row as coming back, in success", () => {
    assert.equal(movementLabel("RETURNED"), "Came back");
    assert.equal(movementTone("RETURNED"), "success");
  });
});

describe("conditionLabel", () => {
  it("labels every ASSET_CONDITIONS code", () => {
    assert.equal(conditionLabel("BRAND_NEW"), "Brand new");
    assert.equal(conditionLabel("EXCELLENT"), "Excellent");
    assert.equal(conditionLabel("GOOD"), "Good");
    assert.equal(conditionLabel("REPAIR"), "Needs repair");
    assert.equal(conditionLabel("UNUSABLE"), "Unusable");
  });

  it("title-cases an unrecognised code instead of dropping it", () => {
    assert.equal(conditionLabel("SOME_FUTURE_CODE"), "Some future code");
  });

  it("renders a missing condition as an em dash", () => {
    assert.equal(conditionLabel(null), "—");
    assert.equal(conditionLabel(undefined), "—");
  });
});
