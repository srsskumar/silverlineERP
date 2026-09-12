/**
 * Geometry helpers for the map layers. Pure, so they are unit-tested without a
 * browser or a WebGL context.
 */

/**
 * Approximates a circle as a GeoJSON ring, which is what MapLibre can fill —
 * it has no native circle-on-the-ground primitive (its `circle` layer draws a
 * fixed pixel radius that does not scale with zoom, so a 400 m fence would look
 * the same size at every zoom level).
 *
 * Returns [lng, lat] pairs, GeoJSON order, with the ring closed.
 */
export function circleToRing(
  lat: number,
  lng: number,
  radiusM: number,
  steps = 64,
): Array<[number, number]> {
  const ring: Array<[number, number]> = [];
  // One degree of latitude is ~110.574 km everywhere; one degree of longitude
  // shrinks with the cosine of latitude, which is why the two differ here.
  const dLat = radiusM / 110_574;
  const cos = Math.cos((lat * Math.PI) / 180);
  // Guard the poles, where cos → 0 and the longitude delta would blow up.
  const dLng = radiusM / (111_320 * (Math.abs(cos) < 1e-6 ? 1e-6 : cos));
  for (let i = 0; i <= steps; i += 1) {
    const theta = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(theta), lat + dLat * Math.sin(theta)]);
  }
  return ring;
}

/** Converts contract [lat, lng] tuples to a closed GeoJSON [lng, lat] ring. */
export function pointsToRing(
  points: ReadonlyArray<[number, number]>,
): Array<[number, number]> {
  const ring: Array<[number, number]> = points.map(([lat, lng]) => [lng, lat]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  // GeoJSON polygons must close; the contract stores open rings.
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}
