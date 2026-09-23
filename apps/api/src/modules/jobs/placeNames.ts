import type { Pool } from "pg";
import { reverseGeocode, type PlaceResolution } from "../geo/routes.js";

/**
 * Naming the place each punch was made from (owner request, 2026-09-23).
 *
 * A punch stores its coordinates the moment it arrives; the village or town
 * those coordinates are in comes from a public geocoder that answers one
 * request a second, so the name is filled in here, afterwards, by the
 * worker. Until then the screens say "resolving".
 *
 * Oldest first, a bounded batch per pass, and a punch the provider keeps
 * failing on is given up after a few tries -- marked resolved with no name
 * -- rather than blocking every punch behind it forever. A provider that
 * answers "nothing here" (open sea, a bad fix) is final at once.
 */

/** Positioned punches named in one pass; at one a second this is half a minute. */
export const PLACE_BATCH = 30;

/** Provider failures before a punch is left unnamed for good. */
export const PLACE_MAX_ATTEMPTS = 3;

export type Resolver = (lat: number, lng: number) => Promise<PlaceResolution>;

export interface PlaceNamesResult {
  named: number;
  /** Answered by the provider with no place: resolved, nameless. */
  empty: number;
  failed: number;
  /** Failed for the last time and left unnamed. */
  abandoned: number;
}

/** Whether the worker should ask the geocoder at all (GEOCODING_REVERSE=off stops it). */
export function reverseGeocodingEnabled(): boolean {
  return (process.env["GEOCODING_REVERSE"] ?? "on").toLowerCase() !== "off";
}

export async function runPlaceNames(pool: Pool, resolve: Resolver = reverseGeocode): Promise<PlaceNamesResult> {
  const result: PlaceNamesResult = { named: 0, empty: 0, failed: 0, abandoned: 0 };
  const pending = await pool.query(
    `SELECT id, lat, lng, place_attempts FROM attendance_events
      WHERE lat IS NOT NULL AND lng IS NOT NULL AND place_resolved_at IS NULL
        AND place_attempts < $1
      ORDER BY server_timestamp ASC
      LIMIT $2`,
    [PLACE_MAX_ATTEMPTS, PLACE_BATCH],
  );
  for (const row of pending.rows as Array<{ id: string; lat: number; lng: number; place_attempts: number }>) {
    let place: PlaceResolution;
    try {
      place = await resolve(Number(row.lat), Number(row.lng));
    } catch {
      const attempts = Number(row.place_attempts) + 1;
      const abandoned = attempts >= PLACE_MAX_ATTEMPTS;
      await pool.query(
        `UPDATE attendance_events
            SET place_attempts = $2,
                place_resolved_at = CASE WHEN $3::boolean THEN NOW() ELSE place_resolved_at END
          WHERE id = $1::uuid`,
        [row.id, attempts, abandoned],
      );
      result.failed += 1;
      if (abandoned) result.abandoned += 1;
      continue;
    }
    await pool.query(
      `UPDATE attendance_events
          SET place_name = $2, place_detail = $3::jsonb, place_resolved_at = NOW(),
              place_attempts = place_attempts + 1
        WHERE id = $1::uuid`,
      [row.id, place.place_name, place.place_detail ? JSON.stringify(place.place_detail) : null],
    );
    if (place.place_name) result.named += 1;
    else result.empty += 1;
  }
  return result;
}
