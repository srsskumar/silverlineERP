/**
 * Attendance anti-fraud heuristics (requirements §9.3).
 *
 * Pure and dependency-free so all three runtimes can use them: the Android
 * client warns the user before submitting, and the server re-runs the same
 * check as the authority. Keeping one implementation is the point — a
 * client-only check is trivially bypassed, and a divergent server check would
 * flag different punches than the app warned about.
 *
 * Every result here is advisory. Nothing in this file should ever block a
 * punch: a real field user on a cheap handset in a steel warehouse must not be
 * locked out by a heuristic.
 */

import { haversineMeters } from "./geo.js";

/** Fastest plausible ground travel for a field user, metres per second. */
export const MAX_PLAUSIBLE_SPEED_MPS = 55; // ~200 km/h — a car or train, not a plane.

/** Below this gap two fixes are treated as the same moment (GPS jitter). */
export const MIN_ELAPSED_MS = 5_000;

/** The minimum a position needs for an anomaly check. */
export interface TimedPosition {
  latitude: number;
  longitude: number;
  /** Reported accuracy radius in metres; null when the OS gives none. */
  accuracy: number | null;
  /** Epoch milliseconds. */
  timestamp: number;
}

export interface MovementAnomaly {
  /** Straight-line distance from the previous fix, metres. */
  distance_m: number;
  /** Time since the previous fix, milliseconds. */
  elapsed_ms: number;
  /** Implied ground speed after subtracting accuracy slack, metres per second. */
  implied_speed_mps: number;
  /** True when the implied speed exceeds what ground travel can explain. */
  impossible_travel: boolean;
}

/**
 * Compares a new fix against the previous one.
 *
 * Returns null when there is nothing to compare, or when the two fixes are
 * closer together in time than the jitter floor — two readings 200 ms apart
 * imply an absurd speed from a few metres of GPS noise, and flagging that would
 * bury the real signal in false positives.
 */
export function detectMovementAnomaly(
  previous: TimedPosition | null,
  current: TimedPosition,
  maxSpeedMps: number = MAX_PLAUSIBLE_SPEED_MPS,
): MovementAnomaly | null {
  if (!previous) return null;
  const elapsed = current.timestamp - previous.timestamp;
  if (elapsed < MIN_ELAPSED_MS) return null;
  const distance = haversineMeters(
    previous.latitude,
    previous.longitude,
    current.latitude,
    current.longitude,
  );
  // Subtract the combined accuracy radius: two fixes each ±50 m can differ by
  // 100 m without anyone moving, and that must not read as travel.
  const slack = (previous.accuracy ?? 0) + (current.accuracy ?? 0);
  const effective = Math.max(0, distance - slack);
  const speed = effective / (elapsed / 1000);
  return {
    distance_m: Math.round(distance),
    elapsed_ms: elapsed,
    implied_speed_mps: Number(speed.toFixed(2)),
    impossible_travel: speed > maxSpeedMps,
  };
}

/**
 * Known emulator/simulator markers. The platform's own "is this real hardware"
 * check covers the honest case; these catch images that report themselves as
 * physical. Deliberately conservative — a false positive costs a real user a
 * manual review.
 */
const EMULATOR_MARKERS = [
  "generic",
  "emulator",
  "sdk_gphone",
  "sdk_google",
  "android sdk built for",
  "genymotion",
  "vbox",
  "goldfish",
  "ranchu",
  "simulator",
];

export function looksLikeEmulator(
  modelName: string | null,
  manufacturer: string | null,
  buildId: string | null,
): boolean {
  const haystack = [modelName, manufacturer, buildId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!haystack) return false;
  return EMULATOR_MARKERS.some((m) => haystack.includes(m));
}

/** A point the OS can be asked to watch for enter/exit. */
export interface MonitoredRegion {
  id: string;
  latitude: number;
  longitude: number;
}

/**
 * The regions closest to a position, capped.
 *
 * Both mobile platforms cap how many regions they will monitor (20 on iOS, 100
 * on Android) and silently ignore the rest, so the selection has to happen in
 * our code where the UI can report how many are actually being watched.
 */
export function nearestRegions<T extends MonitoredRegion>(
  regions: readonly T[],
  from: { latitude: number; longitude: number },
  limit: number,
): T[] {
  return [...regions]
    .map((region) => ({
      region,
      distance: haversineMeters(from.latitude, from.longitude, region.latitude, region.longitude),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((x) => x.region);
}
