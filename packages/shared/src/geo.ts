/**
 * Geo-fence math shared by the API, the web client and the Android client.
 *
 * Previously this lived only in the API, so the mobile app could not tell a
 * field user whether they were inside a fence until the server answered. It is
 * pure and dependency-free, so all three runtimes can evaluate the same rule;
 * the server still re-evaluates every punch, and remains the only authority.
 */
// Geometry shapes come from the S2 contract schemas so the validator and the
// math can never drift apart.
import type { CircleGeometry, PolygonGeometry } from "./s2.js";

export interface FenceShape {
  geometry_type: "circle" | "polygon";
  geometry: CircleGeometry | PolygonGeometry;
  tolerance_meters: number | null;
}

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

/**
 * Ray-cast point-in-polygon. Points are [lat, lng]; lng is treated as the
 * x-axis and lat as y. Points exactly on an edge count as inside.
 */
export function pointInPolygon(
  lat: number,
  lng: number,
  points: Array<[number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [lati, lngi] = points[i] as [number, number];
    const [latj, lngj] = points[j] as [number, number];
    if (onSegment(lat, lng, lati, lngi, latj, lngj)) {
      return true;
    }
    if (
      lngi > lng !== lngj > lng &&
      lat < ((latj - lati) * (lng - lngi)) / (lngj - lngi) + lati
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function onSegment(
  lat: number,
  lng: number,
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): boolean {
  const cross =
    (lng - lng1) * (lat2 - lat1) - (lat - lat1) * (lng2 - lng1);
  if (Math.abs(cross) > 1e-9) {
    return false;
  }
  const dot =
    (lng - lng1) * (lng - lng2) + (lat - lat1) * (lat - lat2);
  return dot <= 1e-9;
}

/**
 * Shortest distance (meters) from a point to a lat/lng segment, using an
 * equirectangular projection around the segment midpoint. Accurate to
 * well under a meter for fence-scale distances.
 */
export function distanceToSegmentMeters(
  lat: number,
  lng: number,
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const refLat = toRad((lat1 + lat2) / 2);
  const kx = EARTH_RADIUS_M * Math.cos(refLat);
  const ky = EARTH_RADIUS_M;
  const px = toRad(lng) * kx;
  const py = toRad(lat) * ky;
  const ax = toRad(lng1) * kx;
  const ay = toRad(lat1) * ky;
  const bx = toRad(lng2) * kx;
  const by = toRad(lat2) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distanceToPolygonEdgeMeters(
  lat: number,
  lng: number,
  points: Array<[number, number]>,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const [lat1, lng1] = points[i] as [number, number];
    const [lat2, lng2] = points[(i + 1) % points.length] as [number, number];
    const d = distanceToSegmentMeters(lat, lng, lat1, lng1, lat2, lng2);
    if (d < best) {
      best = d;
    }
  }
  return best;
}

/**
 * True when (lat, lng) is inside the fence boundary expanded by
 * tolerance_meters (circle: radius + tolerance; polygon: inside the ring
 * or within tolerance of any edge).
 */
export function isInsideFence(
  fence: FenceShape,
  lat: number,
  lng: number,
): boolean {
  const tolerance = fence.tolerance_meters ?? 0;
  if (fence.geometry_type === "circle") {
    const g = fence.geometry as CircleGeometry;
    return haversineMeters(lat, lng, g.lat, g.lng) <= g.radius_m + tolerance;
  }
  const g = fence.geometry as PolygonGeometry;
  if (g.points.length < 3) {
    return false;
  }
  if (pointInPolygon(lat, lng, g.points)) {
    return true;
  }
  if (tolerance <= 0) {
    return false;
  }
  return distanceToPolygonEdgeMeters(lat, lng, g.points) <= tolerance;
}
