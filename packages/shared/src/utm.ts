/**
 * WGS84 → UTM, in pure arithmetic.
 *
 * The owner asked that every punch carry northing and easting in the
 * Universal Transverse Mercator system (datum WGS-1984), which is what the
 * survey crews' instruments and drawings use -- their sites in Telangana and
 * Andhra fall in zone 44 North. Nothing here needs a library: the forward
 * projection is Krüger's series as given by Karney (2011, "Transverse
 * Mercator with an accuracy of a few nanometers"), truncated at n⁶, which is
 * accurate to well under a millimetre anywhere inside a zone.
 *
 * The zone comes from the longitude, with the two conventional exceptions
 * (south-west Norway widens zone 32; Svalbard uses zones 31, 33, 35 and 37),
 * and the hemisphere from the latitude. Coordinates are reported in metres
 * to two decimal places, which is finer than any phone's fix.
 */

/** WGS84 semi-major axis, metres. */
const A = 6378137;
/** WGS84 flattening. */
const F = 1 / 298.257223563;
/** UTM scale factor on the central meridian. */
const K0 = 0.9996;
/** False easting, metres. */
const FALSE_EASTING = 500000;
/** False northing for the southern hemisphere, metres. */
const FALSE_NORTHING_SOUTH = 10000000;

// Third flattening and the series coefficients, computed once.
const N = F / (2 - F);
const N2 = N * N, N3 = N2 * N, N4 = N3 * N, N5 = N4 * N, N6 = N5 * N;
/** Rectifying radius. */
const RECTIFYING_A = (A / (1 + N)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);
const ALPHA = [
  N / 2 - (2 * N2) / 3 + (5 * N3) / 16 + (41 * N4) / 180 - (127 * N5) / 288 + (7891 * N6) / 37800,
  (13 * N2) / 48 - (3 * N3) / 5 + (557 * N4) / 1440 + (281 * N5) / 630 - (1983433 * N6) / 1935360,
  (61 * N3) / 240 - (103 * N4) / 140 + (15061 * N5) / 26880 + (167603 * N6) / 181440,
  (49561 * N4) / 161280 - (179 * N5) / 168 + (6601661 * N6) / 7257600,
  (34729 * N5) / 80640 - (3418889 * N6) / 1995840,
  (212378941 * N6) / 319334400,
];
/** 2√n / (1 + n), the constant in the conformal-latitude step. */
const CONFORMAL_K = (2 * Math.sqrt(N)) / (1 + N);

export type Hemisphere = "N" | "S";

export interface UtmCoordinate {
  /** 1..60. */
  zone: number;
  hemisphere: Hemisphere;
  /** Metres, two decimal places. */
  easting: number;
  /** Metres, two decimal places. */
  northing: number;
}

/**
 * The UTM zone a longitude falls in, given the latitude for the exceptions.
 *
 * Longitude 180 belongs to zone 60, not to a sixty-first.
 */
export function utmZone(latitude: number, longitude: number): number {
  // Norway: zone 32 is widened to cover the south-west coast.
  if (latitude >= 56 && latitude < 64 && longitude >= 3 && longitude < 12) return 32;
  // Svalbard: four wide zones rather than seven narrow ones.
  if (latitude >= 72 && latitude < 84) {
    if (longitude >= 0 && longitude < 9) return 31;
    if (longitude >= 9 && longitude < 21) return 33;
    if (longitude >= 21 && longitude < 33) return 35;
    if (longitude >= 33 && longitude < 42) return 37;
  }
  return Math.min(60, Math.floor((longitude + 180) / 6) + 1);
}

/** Central meridian of a zone, degrees. */
export function utmCentralMeridian(zone: number): number {
  return (zone - 1) * 6 - 180 + 3;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Project a WGS84 position to UTM.
 *
 * Returns null for anything that is not a finite pair inside the UTM
 * latitude band (80°S..84°N): a punch from a research station at the pole
 * would need UPS, and a NaN is not a position.
 */
export function toUtm(latitude: number, longitude: number): UtmCoordinate | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -80 || latitude > 84 || longitude < -180 || longitude > 180) return null;
  const zone = utmZone(latitude, longitude);
  const hemisphere: Hemisphere = latitude >= 0 ? "N" : "S";
  const phi = toRad(latitude);
  const dLambda = toRad(longitude - utmCentralMeridian(zone));

  // Conformal latitude, via Karney's closed form.
  const sinPhi = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sinPhi) - CONFORMAL_K * Math.atanh(CONFORMAL_K * sinPhi));
  const xiPrime = Math.atan2(t, Math.cos(dLambda));
  const etaPrime = Math.atanh(Math.sin(dLambda) / Math.sqrt(1 + t * t));

  let xi = xiPrime;
  let eta = etaPrime;
  for (let j = 1; j <= ALPHA.length; j += 1) {
    const a = ALPHA[j - 1]!;
    xi += a * Math.sin(2 * j * xiPrime) * Math.cosh(2 * j * etaPrime);
    eta += a * Math.cos(2 * j * xiPrime) * Math.sinh(2 * j * etaPrime);
  }

  const easting = FALSE_EASTING + K0 * RECTIFYING_A * eta;
  const northing = (hemisphere === "S" ? FALSE_NORTHING_SOUTH : 0) + K0 * RECTIFYING_A * xi;
  return { zone, hemisphere, easting: round2(easting), northing: round2(northing) };
}

/**
 * "UTM 44N E 232,345.67 N 1,923,456.78" -- the way a surveyor reads it.
 *
 * Thousands are grouped so a six- or seven-figure metre count can be read at
 * a glance; two decimals are kept because the stored value has them.
 */
export function formatUtm(c: Pick<UtmCoordinate, "zone" | "hemisphere" | "easting" | "northing">): string {
  const m = (v: number) => {
    const fixed = Math.abs(v).toFixed(2);
    const [whole, frac] = fixed.split(".");
    const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${v < 0 ? "-" : ""}${grouped}.${frac}`;
  };
  return `UTM ${c.zone}${c.hemisphere} E ${m(c.easting)} N ${m(c.northing)}`;
}
