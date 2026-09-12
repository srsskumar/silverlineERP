/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// src/device/geofencing re-exports these around expo-location; the selection
// logic itself lives in shared so it is testable without React Native.
import { nearestRegions, type MonitoredRegion } from "@silverline/shared";

/** Mirrors MAX_MONITORED_REGIONS in src/device/geofencing (iOS caps at 20). */
const MAX_MONITORED_REGIONS = 20;
type MonitoredFence = MonitoredRegion & { name: string; radius_m: number };
const nearestFences = (
  fences: readonly MonitoredFence[],
  from: { latitude: number; longitude: number },
  limit: number = MAX_MONITORED_REGIONS,
) => nearestRegions(fences, from, limit);

function fence(id: string, latitude: number, longitude: number): MonitoredFence {
  return { id, name: id, latitude, longitude, radius_m: 100 };
}

describe("nearestFences", () => {
  const here = { latitude: 17.44, longitude: 78.34 };

  it("orders by distance from the user", () => {
    const far = fence("far", 17.9, 78.9);
    const near = fence("near", 17.441, 78.341);
    const mid = fence("mid", 17.5, 78.4);
    const out = nearestFences([far, mid, near], here);
    assert.deepEqual(
      out.map((f) => f.id),
      ["near", "mid", "far"],
    );
  });

  it("caps at the platform region limit", () => {
    // iOS silently ignores regions past 20, so the cap must be applied here
    // where the UI can report how many are actually being watched.
    const many = Array.from({ length: 60 }, (_, i) => fence(`f${i}`, 17.44 + i * 0.01, 78.34));
    const out = nearestFences(many, here);
    assert.equal(out.length, MAX_MONITORED_REGIONS);
    assert.equal(out[0].id, "f0", "closest survives the cap");
  });

  it("honours an explicit lower limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => fence(`f${i}`, 17.44 + i * 0.01, 78.34));
    assert.equal(nearestFences(many, here, 3).length, 3);
  });

  it("does not mutate the input list", () => {
    const list = [fence("b", 17.9, 78.9), fence("a", 17.441, 78.341)];
    const before = list.map((f) => f.id);
    nearestFences(list, here);
    assert.deepEqual(
      list.map((f) => f.id),
      before,
    );
  });

  it("returns an empty list when there are no fences", () => {
    assert.deepEqual(nearestFences([], here), []);
  });
});
