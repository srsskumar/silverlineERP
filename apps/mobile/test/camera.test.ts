import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BURN_QUALITY_LADDER,
  MAX_BURN_ATTEMPTS,
  MAX_EVIDENCE_BYTES,
  WatermarkTooLargeError,
  buildWatermarkLines,
  formatTimestampIST,
  isRetryableCaptureError,
  isWithinEvidenceBudget,
  qualityForBurnAttempt,
  renderWatermarkText,
  sha256Hex,
  sha256HexOfText,
  stableEvidenceFileName,
} from "../src/device/camera.js";

describe("renderWatermarkText (legacy sidecar shape)", () => {
  it("is byte-identical to the pre-burn-in format for legacy inputs", () => {
    assert.equal(
      renderWatermarkText({
        name: "Asha Verma",
        empNo: "EMP042",
        latitude: 12.9716,
        longitude: 77.5946,
        timestamp: "duty log 08-Sep",
      }),
      "Asha Verma · EMP042 · 12.971600, 77.594600 · duty log 08-Sep",
    );
  });
  it("renders no-gps when the fix is missing", () => {
    assert.equal(
      renderWatermarkText({
        name: "Asha Verma",
        empNo: "EMP042",
        latitude: null,
        longitude: null,
        timestamp: "duty log 08-Sep",
      }),
      "Asha Verma · EMP042 · no-gps · duty log 08-Sep",
    );
  });
});

describe("buildWatermarkLines (burned strip)", () => {
  it("emits employee / gps+accuracy / IST timestamp / site lines", () => {
    const lines = buildWatermarkLines({
      name: "Asha Verma",
      empNo: "EMP042",
      latitude: 12.9716,
      longitude: 77.5946,
      accuracy: 8.4,
      timestamp: "2026-01-15T00:00:00.000Z",
      projectSite: "Whitefield Site A",
      village: "Varthur",
    });
    assert.equal(lines.length, 4);
    assert.equal(lines[0], "Asha Verma · EMP042");
    assert.equal(lines[1], "12.971600, 77.594600 ±8m");
    assert.ok(lines[2].endsWith(" IST"));
    assert.equal(lines[3], "Whitefield Site A · Varthur");
  });
  it("omits the site line when project/village are absent", () => {
    const lines = buildWatermarkLines({
      name: "Asha Verma",
      empNo: "EMP042",
      latitude: 12.5,
      longitude: 77.5,
      timestamp: "duty log 08-Sep",
    });
    assert.deepEqual(lines, [
      "Asha Verma · EMP042",
      "12.500000, 77.500000",
      "duty log 08-Sep",
    ]);
  });
});

describe("formatTimestampIST", () => {
  it("renders a UTC instant as IST wall time", () => {
    const s = formatTimestampIST("2026-01-15T00:00:00.000Z");
    assert.ok(s.includes("IST"));
    assert.ok(s.includes("2026"));
    assert.ok(s.includes("05:30")); // +05:30
  });
  it("passes display strings through verbatim", () => {
    assert.equal(formatTimestampIST("duty log 08-Sep"), "duty log 08-Sep");
    assert.equal(formatTimestampIST("08-Sep-2026 14:32"), "08-Sep-2026 14:32");
  });
});

describe("burn quality ladder + budget", () => {
  it("ladder is [0.6, 0.5, 0.4] over 3 attempts, then spent", () => {
    assert.deepEqual([...BURN_QUALITY_LADDER], [0.6, 0.5, 0.4]);
    assert.equal(MAX_BURN_ATTEMPTS, 3);
    assert.equal(qualityForBurnAttempt(0), 0.6);
    assert.equal(qualityForBurnAttempt(1), 0.5);
    assert.equal(qualityForBurnAttempt(2), 0.4);
    assert.equal(qualityForBurnAttempt(3), null);
    assert.equal(qualityForBurnAttempt(-1), 0.6);
  });
  it("budget is exactly 200KB, boundary-inclusive", () => {
    assert.equal(MAX_EVIDENCE_BYTES, 200 * 1024);
    assert.equal(isWithinEvidenceBudget(200 * 1024), true);
    assert.equal(isWithinEvidenceBudget(200 * 1024 + 1), false);
    assert.equal(isWithinEvidenceBudget(-1), false);
  });
  it("stable file names derive from the content hash", () => {
    assert.equal(
      stableEvidenceFileName(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ),
      "evidence-ba7816bf8f01.jpg",
    );
  });
});

describe("vendored sha256 (FIPS-180-4 vectors)", () => {
  it('sha256("") matches the known vector', () => {
    assert.equal(
      sha256HexOfText(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it('sha256("abc") matches the known vector', () => {
    assert.equal(
      sha256HexOfText("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("accepts raw bytes and emits 64 lowercase hex chars", () => {
    const hex = sha256Hex(new Uint8Array([0, 1, 2, 255]));
    assert.equal(hex.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(hex));
  });
});

describe("WatermarkTooLargeError (retryable by queue convention)", () => {
  it("carries code + retryable flag", () => {
    const err = new WatermarkTooLargeError(300 * 1024);
    assert.ok(err instanceof Error);
    assert.equal(err.code, "EVIDENCE_TOO_LARGE");
    assert.equal(err.retryable, true);
    assert.equal(isRetryableCaptureError(err), true);
  });
  it("rejects non-retryable errors", () => {
    assert.equal(isRetryableCaptureError(new Error("nope")), false);
    assert.equal(isRetryableCaptureError({ retryable: true }), true);
  });
});
