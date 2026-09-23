/**
 * Geo maths shared by the API, the web client and the Android client.
 *
 * Silverline has no geo-fencing (decision 2026-09-22): a punch is accepted with
 * or without a position and is never judged against a boundary. What remains
 * is the one distance function the anti-fraud rules need, so the
 * impossible-travel check gives the same answer on the device and on the
 * server.
 */

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two WGS84 points, in meters. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
