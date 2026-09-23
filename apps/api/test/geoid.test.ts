import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { geoidHeight, loadGeoidGrid, orthometricHeight } from "../src/common/geoid.js";

/*
 * A second reading of the same grid, written here from the PGM header
 * comments alone, so the module's decoding is checked against the file
 * rather than against itself: header text up to the fourth numeric token,
 * then 16-bit big-endian samples, value = Offset + Scale × pixel, row 0 at
 * 90°N, column 0 at 0°E.
 */
const raw = readFileSync(fileURLToPath(new URL("../src/data/egm96-15.pgm", import.meta.url)));
const header = raw.toString("latin1", 0, 600);
const OFFSET = Number(/# Offset (\S+)/.exec(header)![1]);
const SCALE = Number(/# Scale (\S+)/.exec(header)![1]);
const MAX_BILINEAR_ERROR = Number(/# MaxBilinearError (\S+)/.exec(header)![1]);
const [WIDTH, HEIGHT] = /\n(\d+) (\d+)\n65535\n/.exec(header)!.slice(1, 3).map(Number) as [number, number];
const DATA_START = raw.length - WIDTH * HEIGHT * 2;

function pixel(col: number, row: number): number {
  return OFFSET + SCALE * raw.readUInt16BE(DATA_START + (row * WIDTH + col) * 2);
}

/** Bilinear interpolation done by hand, straight off the samples. */
function byHand(lat: number, lon: number): number {
  const step = 360 / WIDTH;
  const x = (((lon % 360) + 360) % 360) / step;
  const y = (90 - lat) / step;
  const c = Math.floor(x), r = Math.floor(y);
  const dx = x - c, dy = y - r;
  const c1 = (c + 1) % WIDTH;
  return (1 - dx) * (1 - dy) * pixel(c, r) + dx * (1 - dy) * pixel(c1, r)
    + (1 - dx) * dy * pixel(c, r + 1) + dx * dy * pixel(c1, r + 1);
}

describe("EGM96 geoid grid", () => {
  it("decodes the shipped file as 1440 × 721 sixteen-bit samples at 15 minutes", () => {
    const g = loadGeoidGrid();
    expect(g.width).toBe(1440);
    expect(g.height).toBe(721);
    expect(g.step).toBe(0.25);
    expect(g.offset).toBe(-108);
    expect(g.scale).toBe(0.003);
  });

  it("gives the published undulation at the origin of the model", () => {
    // EGM96 at 0°N 0°E is 17.16 m; the sample there is exact, no interpolation.
    expect(geoidHeight(0, 0)).toBeCloseTo(17.16, 1);
  });

  it("puts the geoid about seventy-seven metres below the ellipsoid at Hyderabad", () => {
    // The Indian Ocean geoid low: a phone's altitude at Charminar reads
    // seventy-odd metres higher than the survey benchmark says.
    const n = geoidHeight(17.385, 78.4867)!;
    expect(n).toBeLessThan(-70);
    expect(n).toBeGreaterThan(-85);
    expect(n).toBeCloseTo(-77.09, 1);
  });

  it("matches a hand interpolation of the raw samples, worldwide", () => {
    const points: Array<[number, number]> = [
      [17.385, 78.4867],     // Hyderabad
      [27.9881, 86.925],     // Everest, about -28.9
      [-33.8688, 151.2093],  // Sydney, about +22.4
      [51.5074, -0.1278],    // London, west of Greenwich: wraps to column 1439
      [40.7128, -74.006],    // New York
      [-89.9, 12],           // last row before the pole
      [17.25, 78.5],         // exactly on a sample: no interpolation at all
      [0.1, 359.9],          // just short of wrapping back to column 0
    ];
    for (const [lat, lon] of points) {
      expect(geoidHeight(lat, lon), `N at ${lat},${lon}`).toBeCloseTo(byHand(lat, lon), 3);
    }
    // And the model's own bound on bilinear error is what separates these
    // from the true surface, not anything this code adds.
    expect(MAX_BILINEAR_ERROR).toBeLessThan(1.5);
    expect(geoidHeight(27.9881, 86.925)).toBeCloseTo(-28.7, 0);
  });

  it("wraps at the antimeridian and holds at the poles", () => {
    expect(geoidHeight(10, 180)).toBeCloseTo(geoidHeight(10, -180)!, 6);
    expect(geoidHeight(10, 359.999)).toBeCloseTo(geoidHeight(10, -0.001)!, 6);
    expect(geoidHeight(90, 0)).toBeCloseTo(pixel(0, 0), 6);
    expect(geoidHeight(-90, 45)).toBeCloseTo(pixel(180, HEIGHT - 1), 6);
  });

  it("refuses what is not a position", () => {
    expect(geoidHeight(Number.NaN, 0)).toBeNull();
    expect(geoidHeight(91, 0)).toBeNull();
  });
});

describe("orthometricHeight", () => {
  it("takes the undulation off the ellipsoidal altitude", () => {
    // 500 m on the phone at Hyderabad is about 577 m above sea level.
    const h = orthometricHeight(500, 17.385, 78.4867)!;
    expect(h).toBeCloseTo(500 - geoidHeight(17.385, 78.4867)!, 2);
    expect(h).toBeGreaterThan(570);
  });

  it("is nothing without an altitude", () => {
    expect(orthometricHeight(null, 17.385, 78.4867)).toBeNull();
    expect(orthometricHeight(undefined, 17.385, 78.4867)).toBeNull();
    expect(orthometricHeight(Number.NaN, 17.385, 78.4867)).toBeNull();
  });
});
