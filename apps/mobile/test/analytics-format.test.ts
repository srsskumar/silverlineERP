/// <reference types="node" />
/**
 * Pure display rules behind the Analytics screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { delayRiskTone, formatConfidence } from "../src/analyticsFormat";

describe("delayRiskTone", () => {
  it("colours HIGH danger, LOW success, anything else neutral", () => {
    assert.equal(delayRiskTone("HIGH"), "danger");
    assert.equal(delayRiskTone("LOW"), "success");
    assert.equal(delayRiskTone(null), "neutral");
    assert.equal(delayRiskTone(undefined), "neutral");
  });
});

describe("formatConfidence", () => {
  it("renders a fraction as a rounded percent", () => {
    assert.equal(formatConfidence(0.723), "72%");
    assert.equal(formatConfidence(0.4), "40%");
  });

  it("renders null/undefined as unavailable", () => {
    assert.equal(formatConfidence(null), "unavailable");
    assert.equal(formatConfidence(undefined), "unavailable");
  });
});
