import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * EGM96 geoid undulation, from the 15-arc-minute grid in src/data.
 *
 * A phone reports altitude above the WGS84 ellipsoid. The owner's drawings
 * and the survey instruments work in orthometric height -- height above the
 * geoid, which is what "above sea level" means -- in the EGM96 global model.
 * The two differ by the undulation N, which is about −77 m around
 * Hyderabad, so a raw phone altitude written on a survey record would be
 * wrong by the height of a twenty-storey building.
 *
 * The grid is GeographicLib's `egm96-15.pgm` (see src/data/README.md):
 * 1440 × 721 sixteen-bit samples, origin at 90°N 0°E, value = offset +
 * scale × pixel, bilinear interpolation between samples. Its stated
 * worst-case bilinear error is 1.15 m, RMS 4 cm, which is far inside any
 * phone's vertical accuracy.
 *
 * The file is 2 MB and is read once, on first use, so an API that never
 * sees an altitude never loads it.
 */

interface Grid {
  width: number;
  height: number;
  offset: number;
  scale: number;
  /** Degrees between samples. */
  step: number;
  data: Buffer;
  dataStart: number;
}

const GRID_URL = new URL("../data/egm96-15.pgm", import.meta.url);

let grid: Grid | null = null;

function parseHeader(buf: Buffer): Grid {
  let pos = 0;
  const tokens: string[] = [];
  let offset: number | null = null;
  let scale: number | null = null;
  // The header is text: magic, comments, width height, maxval, one
  // newline, then the samples. Only the four numeric tokens are needed.
  while (tokens.length < 4) {
    let end = buf.indexOf(0x0a, pos);
    if (end === -1) throw new Error("EGM96 grid: truncated header");
    const line = buf.toString("latin1", pos, end).trim();
    pos = end + 1;
    if (line.startsWith("#")) {
      const m = /^#\s*(\w+)\s+(.*)$/.exec(line);
      if (m?.[1] === "Offset") offset = Number(m[2]);
      if (m?.[1] === "Scale") scale = Number(m[2]);
      continue;
    }
    if (line) tokens.push(...line.split(/\s+/));
  }
  if (tokens[0] !== "P5") throw new Error("EGM96 grid: not a binary PGM");
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  if (Number(tokens[3]) !== 65535) throw new Error("EGM96 grid: expected 16-bit samples");
  if (offset === null || scale === null) throw new Error("EGM96 grid: header lacks Offset/Scale");
  if (buf.length - pos !== width * height * 2) throw new Error("EGM96 grid: sample count does not match header");
  return { width, height, offset, scale, step: 360 / width, data: buf, dataStart: pos };
}

/** The grid, loaded on first call. Throws if the file is missing or malformed. */
export function loadGeoidGrid(): Grid {
  if (!grid) grid = parseHeader(readFileSync(fileURLToPath(GRID_URL)));
  return grid;
}

function sample(g: Grid, ix: number, iy: number): number {
  return g.offset + g.scale * g.data.readUInt16BE(g.dataStart + (iy * g.width + ix) * 2);
}

/**
 * Geoid height N (metres) at a WGS84 position: ellipsoidal height minus N
 * is the EGM96 orthometric height.
 *
 * Returns null for anything that is not a finite position.
 */
export function geoidHeight(latitude: number, longitude: number): number | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  const g = loadGeoidGrid();
  // Columns run 0°E eastwards and wrap; rows run from 90°N southwards.
  const fx = (((longitude % 360) + 360) % 360) / g.step;
  const fy = (90 - latitude) / g.step;
  const ix = Math.floor(fx) % g.width;
  const iy = Math.min(Math.floor(fy), g.height - 2);
  const ax = fx - Math.floor(fx);
  const ay = fy - iy;
  const ix1 = (ix + 1) % g.width;
  const n =
    (1 - ax) * (1 - ay) * sample(g, ix, iy) +
    ax * (1 - ay) * sample(g, ix1, iy) +
    (1 - ax) * ay * sample(g, ix, iy + 1) +
    ax * ay * sample(g, ix1, iy + 1);
  return Math.round(n * 1000) / 1000;
}

/**
 * EGM96 orthometric height from a device's ellipsoidal altitude, to the
 * centimetre; null when either input is missing.
 */
export function orthometricHeight(
  altitude: number | null | undefined,
  latitude: number,
  longitude: number,
): number | null {
  if (altitude === null || altitude === undefined || !Number.isFinite(altitude)) return null;
  const n = geoidHeight(latitude, longitude);
  if (n === null) return null;
  return Math.round((altitude - n) * 100) / 100;
}
