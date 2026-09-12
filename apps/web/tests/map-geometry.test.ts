import { describe, expect, it } from 'vitest';
import { circleToRing, pointsToRing } from '../components/map/geometry';

/** Rough metres between two WGS84 points, for asserting the ring's radius. */
function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe('circleToRing', () => {
  it('closes the ring', () => {
    const ring = circleToRing(17.44, 78.34, 500, 32);
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('emits [lng, lat] in GeoJSON order', () => {
    // Longitude first: a swapped pair would put a Hyderabad fence in Somalia.
    const [lng, lat] = circleToRing(17.44, 78.34, 100, 8)[0];
    expect(lng).toBeCloseTo(78.34, 1);
    expect(lat).toBeCloseTo(17.44, 1);
  });

  it('produces a ring of about the requested radius', () => {
    const lat = 17.44;
    const lng = 78.34;
    const radius = 500;
    for (const [ringLng, ringLat] of circleToRing(lat, lng, radius, 16)) {
      // 5% tolerance: the equirectangular approximation is not exact, but it
      // must not be wrong enough for an admin to misjudge a site boundary.
      expect(metersBetween(lat, lng, ringLat, ringLng)).toBeGreaterThan(radius * 0.95);
      expect(metersBetween(lat, lng, ringLat, ringLng)).toBeLessThan(radius * 1.05);
    }
  });

  it('stays finite near the poles where the longitude delta would diverge', () => {
    for (const [lng, lat] of circleToRing(90, 0, 1000, 8)) {
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });

  it('scales longitude more than latitude away from the equator', () => {
    // At 60°N a degree of longitude is about half a degree of latitude, so the
    // ring must be wider in degrees than it is tall.
    const ring = circleToRing(60, 10, 1000, 4);
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const lngSpan = Math.max(...lngs) - Math.min(...lngs);
    const latSpan = Math.max(...lats) - Math.min(...lats);
    expect(lngSpan).toBeGreaterThan(latSpan * 1.5);
  });
});

describe('pointsToRing', () => {
  it('swaps [lat, lng] to [lng, lat] and closes the ring', () => {
    const ring = pointsToRing([
      [17.44, 78.34],
      [17.45, 78.35],
      [17.43, 78.36],
    ]);
    expect(ring[0]).toEqual([78.34, 17.44]);
    expect(ring).toHaveLength(4);
    expect(ring[3]).toEqual(ring[0]);
  });

  it('leaves an already-closed ring alone', () => {
    const ring = pointsToRing([
      [17.44, 78.34],
      [17.45, 78.35],
      [17.43, 78.36],
      [17.44, 78.34],
    ]);
    expect(ring).toHaveLength(4);
  });

  it('handles an empty input without throwing', () => {
    expect(pointsToRing([])).toEqual([]);
  });
});
