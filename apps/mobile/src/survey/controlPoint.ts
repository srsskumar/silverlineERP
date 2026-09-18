/**
 * A ground control point, typed on the spot.
 *
 * The person establishing the point is standing on it, which is the one place
 * the coordinates are not a transcription. Everything the server will check is
 * checked here first, through the server's own schema — the point goes into
 * the outbox and a refusal that surfaces tomorrow cannot ask where the pillar
 * was.
 */
import { GCP_WARNING_NOTES, checkGcp, gcpSchema } from "@silverline/shared";
import type { GcpInput } from "../api/endpoints";

export interface PointDraft {
  pointCode: string;
  latitude: string;
  longitude: string;
  elevationM: string;
  eastingM: string;
  northingM: string;
  gridZone: string;
  remarks: string;
  establishedOn: string;
}

export function emptyPoint(establishedOn: string): PointDraft {
  return {
    pointCode: "",
    latitude: "",
    longitude: "",
    elevationM: "",
    eastingM: "",
    northingM: "",
    gridZone: "",
    remarks: "",
    establishedOn,
  };
}

/**
 * A signed decimal, or a reason it is not one.
 *
 * Signed, unlike the quantities on the daily return: a latitude south of the
 * equator and an elevation below sea level are both real, and a form that
 * refuses a minus sign is a form that gets the minus sign left off.
 */
export function parseDecimal(
  text: string,
  label: string,
): { value: number | null; error?: string } {
  const raw = text.trim();
  if (raw === "") return { value: null };
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    return { value: null, error: `${label} must be a number. "${raw.slice(0, 24)}" is not one.` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { value: null, error: `${label} is not a number this app can use.` };
  }
  return { value };
}

export type PointResult =
  | { ok: true; input: GcpInput; warnings: string[] }
  | { ok: false; problems: string[] };

/** How many decimal places a fix carries — six is roughly a tenth of a metre. */
export const GOOD_PRECISION_DP = 6;

export function buildPoint(draft: PointDraft): PointResult {
  const problems: string[] = [];
  const lat = parseDecimal(draft.latitude, "Latitude");
  const lng = parseDecimal(draft.longitude, "Longitude");
  const ele = parseDecimal(draft.elevationM, "Elevation");
  const east = parseDecimal(draft.eastingM, "Easting");
  const north = parseDecimal(draft.northingM, "Northing");
  for (const f of [lat, lng, ele, east, north]) if (f.error) problems.push(f.error);

  if (lat.value === null && !lat.error) problems.push("A control point needs a latitude.");
  if (lng.value === null && !lng.error) problems.push("A control point needs a longitude.");
  if (problems.length) return { ok: false, problems };

  const candidate = {
    point_code: draft.pointCode.trim(),
    latitude: lat.value as number,
    longitude: lng.value as number,
    ...(ele.value !== null ? { elevation_m: ele.value } : {}),
    ...(east.value !== null ? { easting_m: east.value } : {}),
    ...(north.value !== null ? { northing_m: north.value } : {}),
    ...(draft.gridZone.trim() ? { grid_zone: draft.gridZone.trim() } : {}),
    ...(draft.remarks.trim() ? { remarks: draft.remarks.trim() } : {}),
    ...(draft.establishedOn ? { established_on: draft.establishedOn } : {}),
  };

  // The server's schema, not a second reading of it — including the rule that
  // a grid reference needs both numbers and a named zone.
  const parsed = gcpSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map(i => i.message) };
  }

  return {
    ok: true,
    input: candidate as GcpInput,
    // Advisory and never a refusal: every one of these is also something a
    // legitimate programme produces.
    warnings: checkGcp(candidate.latitude, candidate.longitude)
      .map(w => GCP_WARNING_NOTES[w]),
  };
}

/**
 * Fill the coordinates from the device's own fix.
 *
 * A phone fix is metres-accurate at best and a control point is centimetres,
 * so this is a starting position to be overwritten from the controller — the
 * accuracy is carried back so the screen can say so rather than implying the
 * numbers are survey grade.
 */
export function fromDeviceFix(
  draft: PointDraft,
  fix: { latitude: number; longitude: number; altitude?: number | null; accuracy?: number | null },
): PointDraft {
  return {
    ...draft,
    latitude: fix.latitude.toFixed(GOOD_PRECISION_DP),
    longitude: fix.longitude.toFixed(GOOD_PRECISION_DP),
    elevationM: typeof fix.altitude === "number" && Number.isFinite(fix.altitude)
      ? fix.altitude.toFixed(1)
      : draft.elevationM,
  };
}
