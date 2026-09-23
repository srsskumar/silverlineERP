/**
 * Single-fix high-accuracy location for attendance punches.
 * expo-location only (no extra deps).
 */

import * as Location from "expo-location";

/**
 * Below this accuracy (meters) the screen warns that the fix is weak.
 *
 * Advisory only: there is no geo-fence and the server never holds a punch
 * for poor accuracy. The number is stored with the punch as evidence.
 */
export const ACCURACY_THRESHOLD_M = 100;

export interface PunchFix {
  latitude: number;
  longitude: number;
  /** Null when the OS reports no accuracy (treat as poor). */
  accuracy: number | null;
  /** OS mock-location flag — passed through, never hidden from backend. */
  mocked: boolean;
  timestamp: number;
  /**
   * Ellipsoidal (WGS84) altitude and its accuracy, metres; null when the
   * OS has none. The server turns it into a height on the EGM96 geoid for
   * the survey record, which is why it is sent raw rather than adjusted.
   */
  altitude?: number | null;
  altitudeAccuracy?: number | null;
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
    altitude: pos.coords.altitude ?? null,
    altitudeAccuracy: pos.coords.altitudeAccuracy ?? null,
  };
}

/** Human readout for the attendance screen ("±12m · GPS" / "mocked!"). */
export function accuracyLabel(fix: PunchFix | null): string {
  if (!fix) return "no fix";
  const acc =
    fix.accuracy === null ? "unknown accuracy" : `±${Math.round(fix.accuracy)}m`;
  return fix.mocked ? `${acc} · MOCKED` : acc;
}

/** True when the fix is weak enough to warn about. The punch is accepted regardless. */
export function isPoorAccuracy(
  fix: PunchFix,
  thresholdM = ACCURACY_THRESHOLD_M,
): boolean {
  return fix.accuracy === null || fix.accuracy > thresholdM;
}
