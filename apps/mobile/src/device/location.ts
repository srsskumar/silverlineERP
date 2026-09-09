/**
 * Single-fix high-accuracy location for attendance punches.
 * expo-location only (no extra deps).
 */

import * as Location from "expo-location";

/** Default poor-accuracy threshold (meters) — mirrors fence default 100m. */
export const ACCURACY_THRESHOLD_M = 100;

export interface PunchFix {
  latitude: number;
  longitude: number;
  /** Null when the OS reports no accuracy (treat as poor). */
  accuracy: number | null;
  /** OS mock-location flag — passed through, never hidden from backend. */
  mocked: boolean;
  timestamp: number;
}

export async function getPunchFix(): Promise<PunchFix> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") {
    throw new Error("Location permission denied — punch needs GPS");
  }
  const pos = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Highest,
  });
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? null,
    mocked: pos.mocked ?? false,
    timestamp: pos.timestamp,
  };
}

/** Human readout for the attendance screen ("±12m · GPS" / "mocked!"). */
export function accuracyLabel(fix: PunchFix | null): string {
  if (!fix) return "no fix";
  const acc =
    fix.accuracy === null ? "unknown accuracy" : `±${Math.round(fix.accuracy)}m`;
  return fix.mocked ? `${acc} · MOCKED` : acc;
}

/** True when the fix is too poor to auto-accept (backend would 202 it). */
export function isPoorAccuracy(
  fix: PunchFix,
  thresholdM = ACCURACY_THRESHOLD_M,
): boolean {
  return fix.accuracy === null || fix.accuracy > thresholdM;
}
