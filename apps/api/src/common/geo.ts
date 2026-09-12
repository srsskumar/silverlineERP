/**
 * Server-side geo helpers.
 *
 * The fence math moved to @silverline/shared so the Android client can evaluate
 * the same rule on-device; it is re-exported here so existing imports keep
 * working. Only the server-only work-date helper stays local.
 */
export {
  haversineMeters,
  pointInPolygon,
  distanceToSegmentMeters,
  isInsideFence,
  type CircleGeometry,
  type PolygonGeometry,
  type FenceShape,
} from "@silverline/shared";

/** Server-side work date (calendar day) in Asia/Kolkata, YYYY-MM-DD. */
export function kolkataWorkDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
