/// <reference types="node" />
/**
 * Pure display/validation rules behind the Attendance exceptions screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exceptionStatusTone,
  formatExceptionType,
  isTrackableExceptionId,
  parseVersionInput,
} from "../src/attendanceExceptionsFormat";

describe("exceptionStatusTone", () => {
  it("colours the statuses attendanceExceptionStatusSchema allows", () => {
    assert.equal(exceptionStatusTone("APPROVED"), "success");
    assert.equal(exceptionStatusTone("PENDING"), "warning");
    assert.equal(exceptionStatusTone("REJECTED"), "danger");
    assert.equal(exceptionStatusTone("WHATEVER"), "neutral");
  });
});

describe("formatExceptionType", () => {
  it("labels every current and legacy stored type", () => {
    assert.equal(formatExceptionType("MISSED_PUNCH"), "Missed punch");
    assert.equal(formatExceptionType("REGULARIZATION"), "Regularization");
    assert.equal(formatExceptionType("OUTSIDE_GEOFENCE"), "Outside geofence (legacy)");
  });

  it("falls back to the raw code for anything unrecognised", () => {
    assert.equal(formatExceptionType("SOMETHING_NEW"), "SOMETHING_NEW");
  });
});

describe("parseVersionInput", () => {
  it("accepts a positive whole number", () => {
    assert.equal(parseVersionInput("1"), 1);
    assert.equal(parseVersionInput(" 42 "), 42);
  });

  it("rejects zero, negatives, decimals and non-numeric input", () => {
    assert.equal(parseVersionInput("0"), null);
    assert.equal(parseVersionInput("-1"), null);
    assert.equal(parseVersionInput("1.5"), null);
    assert.equal(parseVersionInput("abc"), null);
    assert.equal(parseVersionInput(""), null);
  });
});

describe("isTrackableExceptionId", () => {
  it("accepts a UUID", () => {
    assert.equal(isTrackableExceptionId("123e4567-e89b-12d3-a456-426614174000"), true);
  });

  it("rejects anything else", () => {
    assert.equal(isTrackableExceptionId("not-a-uuid"), false);
    assert.equal(isTrackableExceptionId(""), false);
  });
});
