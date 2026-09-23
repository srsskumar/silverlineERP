import "../common/env.js";
import { Pool } from "pg";
import { toUtm } from "@silverline/shared";
import { orthometricHeight } from "../common/geoid.js";

/**
 * Fill the UTM columns (and EGM96 height, where an altitude exists) on
 * punches recorded before migration 085.
 *
 * A one-off, run by hand and never by a migration: the projection is pure
 * arithmetic, so there is nothing to get wrong by doing it later, and a
 * migration that walks every event row would hold the deploy for as long
 * as the table is long. Place names are not touched here -- the worker
 * names positioned punches oldest first on its own.
 *
 *   npm run backfill:utm --workspace=apps/api             # do it
 *   npm run backfill:utm --workspace=apps/api -- --dry-run # count only
 *
 * Reads DATABASE_URL like the API. Idempotent: only rows with a position
 * and no utm_zone are touched, in batches, so it can be stopped and rerun.
 */

const BATCH = 500;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev" });
  try {
    const pending = Number(
      (await pool.query(
        "SELECT COUNT(*)::int AS n FROM attendance_events WHERE lat IS NOT NULL AND lng IS NOT NULL AND utm_zone IS NULL",
      )).rows[0].n,
    );
    console.log(`${pending} positioned punch(es) without UTM`);
    if (dryRun || pending === 0) return;
    let done = 0;
    for (;;) {
      const rows = (await pool.query(
        `SELECT id, lat, lng, altitude FROM attendance_events
          WHERE lat IS NOT NULL AND lng IS NOT NULL AND utm_zone IS NULL
          ORDER BY server_timestamp ASC LIMIT $1`,
        [BATCH],
      )).rows as Array<{ id: string; lat: number; lng: number; altitude: number | null }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const lat = Number(row.lat), lng = Number(row.lng);
        const utm = toUtm(lat, lng);
        if (!utm) {
          // Outside the UTM bands (polar) or not a number: leave it, and
          // stop it being selected again by marking the zone as unusable.
          await pool.query("UPDATE attendance_events SET utm_zone = 0 WHERE id = $1::uuid", [row.id]);
          continue;
        }
        await pool.query(
          `UPDATE attendance_events
              SET utm_zone = $2, utm_hemisphere = $3, utm_easting = $4, utm_northing = $5,
                  height_egm96 = COALESCE(height_egm96, $6)
            WHERE id = $1::uuid`,
          [row.id, utm.zone, utm.hemisphere, utm.easting, utm.northing,
            orthometricHeight(row.altitude === null ? null : Number(row.altitude), lat, lng)],
        );
      }
      done += rows.length;
      console.log(`${done}/${pending}`);
    }
    console.log("done");
  } finally {
    await pool.end();
  }
}

await main();
