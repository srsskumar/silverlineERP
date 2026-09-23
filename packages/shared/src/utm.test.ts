import { describe, expect, it } from "vitest";
import { formatUtm, toUtm, utmCentralMeridian, utmZone } from "./utm.js";

/*
 * Snyder's transverse Mercator (USGS Professional Paper 1395, equations
 * 8-9 to 8-13): a different derivation from the Krüger series the module
 * uses, good to a few millimetres inside a zone. If the two agree the
 * implementation is right; if they disagree one of them is, and that is
 * the point of having a second.
 */
function snyder(lat: number, lon: number, zone: number, south: boolean) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = (lat * Math.PI) / 180;
  const dl = ((lon - utmCentralMeridian(zone)) * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const aa = dl * Math.cos(phi);
  const e4 = e2 * e2, e6 = e4 * e2;
  const m = a * ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
  const x = k0 * n * (aa + ((1 - t + c) * aa ** 3) / 6
    + ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * aa ** 5) / 120);
  const y = k0 * (m + n * Math.tan(phi) * (aa ** 2 / 2
    + ((5 - t + 9 * c + 4 * c * c) * aa ** 4) / 24
    + ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * aa ** 6) / 720));
  return { easting: 500000 + x, northing: (south ? 10000000 : 0) + y };
}

describe("toUtm", () => {
  it("puts Hyderabad in zone 44 North at the surveyors' figures", () => {
    // The owner's sites: zone 44N, datum WGS-1984. E 232,9xx N 1,923,8xx is
    // what a hand-held GNSS set to UTM reads at Charminar.
    const u = toUtm(17.385, 78.4867)!;
    expect(u.zone).toBe(44);
    expect(u.hemisphere).toBe("N");
    expect(u.easting).toBeCloseTo(232957.62, 1);
    expect(u.northing).toBeCloseTo(1923897.27, 1);
  });

  it("agrees with Snyder's independent formula to a centimetre, worldwide", () => {
    const points: Array<[number, number]> = [
      [17.385, 78.4867],      // Hyderabad, 44N
      [17.4617, 78.3594],     // Kondapur, 44N
      [-33.8688, 151.2093],   // Sydney, 56S
      [51.5074, -0.1278],     // London, 30N, west of Greenwich
      [-33.9249, 18.4241],    // Cape Town, 34S
      [40.7128, -74.006],     // New York, 18N
      [17.0, 84.0],           // on a zone boundary: 45N, far from its meridian
      [-80, 170],             // southern limit of UTM
    ];
    for (const [lat, lon] of points) {
      const u = toUtm(lat, lon)!;
      const s = snyder(lat, lon, u.zone, u.hemisphere === "S");
      expect(Math.abs(u.easting - s.easting), `easting at ${lat},${lon}`).toBeLessThan(0.01);
      expect(Math.abs(u.northing - s.northing), `northing at ${lat},${lon}`).toBeLessThan(0.01);
    }
  });

  it("counts the southern hemisphere from a false northing of ten million", () => {
    const u = toUtm(-33.8688, 151.2093)!;
    expect(u.hemisphere).toBe("S");
    expect(u.northing).toBeGreaterThan(6_000_000);
    expect(u.northing).toBeLessThan(10_000_000);
    // The equator itself is north, at northing zero.
    const eq = toUtm(0, 0)!;
    expect(eq.hemisphere).toBe("N");
    expect(eq.northing).toBe(0);
    expect(eq.easting).toBeCloseTo(166021.44, 1);
  });

  it("reports metres to two decimal places", () => {
    const u = toUtm(17.385, 78.4867)!;
    expect(u.easting).toBe(Math.round(u.easting * 100) / 100);
    expect(u.northing).toBe(Math.round(u.northing * 100) / 100);
  });

  it("refuses what is not a position", () => {
    expect(toUtm(Number.NaN, 78)).toBeNull();
    expect(toUtm(17, Number.POSITIVE_INFINITY)).toBeNull();
    expect(toUtm(89, 10)).toBeNull();   // polar: UPS territory
    expect(toUtm(-85, 10)).toBeNull();
    expect(toUtm(17, 181)).toBeNull();
  });
});

describe("utmZone", () => {
  it("numbers zones from the antimeridian, six degrees each", () => {
    expect(utmZone(17, 78.4867)).toBe(44);
    expect(utmZone(0, -180)).toBe(1);
    expect(utmZone(0, -177)).toBe(1);
    expect(utmZone(0, -174)).toBe(2);
    expect(utmZone(0, 0)).toBe(31);
    expect(utmZone(0, 179.9)).toBe(60);
    // 180°E is the far edge of zone 60, not a sixty-first zone.
    expect(utmZone(0, 180)).toBe(60);
  });

  it("widens zone 32 over south-west Norway", () => {
    expect(utmZone(60.39, 5.32)).toBe(32);   // Bergen would otherwise be 31
    expect(utmZone(55.9, 5.32)).toBe(31);    // south of the exception
    expect(utmZone(64.0, 5.32)).toBe(31);    // north of it
  });

  it("uses the four wide zones over Svalbard", () => {
    expect(utmZone(78.22, 15.63)).toBe(33);  // Longyearbyen
    expect(utmZone(78, 5)).toBe(31);
    expect(utmZone(78, 25)).toBe(35);
    expect(utmZone(78, 35)).toBe(37);
    expect(utmZone(78, 45)).toBe(38);        // east of the exception, ordinary
  });

  it("gives each zone its central meridian", () => {
    expect(utmCentralMeridian(44)).toBe(81);
    expect(utmCentralMeridian(1)).toBe(-177);
    expect(utmCentralMeridian(60)).toBe(177);
  });
});

describe("formatUtm", () => {
  it("reads the way a surveyor writes it", () => {
    expect(formatUtm({ zone: 44, hemisphere: "N", easting: 232345.67, northing: 1923456.78 }))
      .toBe("UTM 44N E 232,345.67 N 1,923,456.78");
    expect(formatUtm({ zone: 31, hemisphere: "N", easting: 166021.44, northing: 0 }))
      .toBe("UTM 31N E 166,021.44 N 0.00");
  });
});
