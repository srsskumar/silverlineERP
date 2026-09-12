/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Imported from the shared package rather than src/device/signals: the device
// module pulls in expo-device (and therefore React Native), which the Node test
// runner cannot transform. The heuristics under test live in shared precisely
// so the server can run them too.
import {
  detectMovementAnomaly,
  looksLikeEmulator,
  MAX_PLAUSIBLE_SPEED_MPS,
  type TimedPosition,
} from "@silverline/shared";

function fix(
  latitude: number,
  longitude: number,
  timestamp: number,
  accuracy: number | null = 10,
): TimedPosition {
  return { latitude, longitude, accuracy, timestamp };
}

describe("looksLikeEmulator", () => {
  it("flags known emulator images", () => {
    assert.equal(looksLikeEmulator("sdk_gphone64_arm64", "Google", null), true);
    assert.equal(looksLikeEmulator("Android SDK built for x86", "unknown", null), true);
    assert.equal(looksLikeEmulator(null, "Genymotion", null), true);
    assert.equal(looksLikeEmulator("iPhone Simulator", "Apple", null), true);
    assert.equal(looksLikeEmulator(null, null, "ranchu-userdebug"), true);
  });

  it("does not flag ordinary handsets", () => {
    assert.equal(looksLikeEmulator("Pixel 7a", "Google", "TQ3A.230805.001"), false);
    assert.equal(looksLikeEmulator("SM-A245F", "samsung", "UP1A.231005.007"), false);
    assert.equal(looksLikeEmulator("iPhone14,5", "Apple", null), false);
  });

  it("returns false when the device reports nothing", () => {
    assert.equal(looksLikeEmulator(null, null, null), false);
  });
});

describe("detectMovementAnomaly", () => {
  it("returns null with no previous fix to compare against", () => {
    assert.equal(detectMovementAnomaly(null, fix(17.44, 78.34, 1_000_000)), null);
  });

  it("ignores fixes closer together than the jitter floor", () => {
    // Two readings 1s apart would imply an absurd speed from GPS noise alone.
    const a = fix(17.44, 78.34, 1_000_000);
    const b = fix(17.4405, 78.3405, 1_001_000);
    assert.equal(detectMovementAnomaly(a, b), null);
  });

  it("accepts ordinary travel", () => {
    // ~1.1 km in 10 minutes: a walk.
    const a = fix(17.44, 78.34, 1_000_000);
    const b = fix(17.45, 78.34, 1_000_000 + 600_000);
    const out = detectMovementAnomaly(a, b);
    assert.ok(out);
    assert.equal(out.impossible_travel, false);
    assert.ok(out.implied_speed_mps < 5);
  });

  it("flags travel no ground transport explains", () => {
    // ~550 km (Hyderabad to Bengaluru) in two minutes.
    const a = fix(17.44, 78.34, 1_000_000);
    const b = fix(12.97, 77.59, 1_000_000 + 120_000);
    const out = detectMovementAnomaly(a, b);
    assert.ok(out);
    assert.equal(out.impossible_travel, true);
    assert.ok(out.implied_speed_mps > MAX_PLAUSIBLE_SPEED_MPS);
  });

  it("subtracts the combined accuracy radius before judging speed", () => {
    // 80 m apart, but each fix is ±100 m: that is noise, not movement, and
    // must not read as travel just because the gap is short.
    const a = fix(17.44, 78.34, 1_000_000, 100);
    const b = fix(17.4407, 78.34, 1_000_000 + 6_000, 100);
    const out = detectMovementAnomaly(a, b);
    assert.ok(out);
    assert.equal(out.implied_speed_mps, 0);
    assert.equal(out.impossible_travel, false);
  });

  it("reports the raw distance even when slack cancels the speed", () => {
    const a = fix(17.44, 78.34, 1_000_000, 100);
    const b = fix(17.4407, 78.34, 1_000_000 + 6_000, 100);
    const out = detectMovementAnomaly(a, b);
    assert.ok(out);
    assert.ok(out.distance_m > 50, "distance is reported unadjusted");
  });
});
