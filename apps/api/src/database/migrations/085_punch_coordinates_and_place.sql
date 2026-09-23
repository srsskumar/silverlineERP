-- Coordinates and a place name on every punch (owner request, 2026-09-23).
--
-- A punch already keeps latitude, longitude and accuracy. The survey crews
-- read positions as UTM northing and easting on WGS-1984 (their sites are
-- zone 44 North), heights as orthometric height on the EGM96 geoid, and a
-- supervisor reading the register wants the village or town, not a pair of
-- decimals. So each event now carries:
--
--   altitude, altitude_accuracy   the device's ellipsoidal altitude, as sent
--   utm_zone, utm_hemisphere,     the projection of lat/lng, computed at
--   utm_easting, utm_northing     insert time (see packages/shared/src/utm.ts)
--   height_egm96                  altitude minus the EGM96 undulation
--   place_name, place_detail      reverse-geocoded, filled in by the
--   place_resolved_at,            background worker; attempts counts the
--   place_attempts                provider failures so a punch the provider
--                                 cannot name does not spin forever
--
-- Additive only. Rows from before this migration keep NULLs; the UTM
-- columns for them are filled by `npm run backfill:utm --workspace=apps/api`
-- (a one-off script, never run by a migration), and their place names by
-- the same worker pass that names new punches, oldest first.

ALTER TABLE attendance_events
  ADD COLUMN IF NOT EXISTS altitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS altitude_accuracy DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS utm_zone SMALLINT,
  ADD COLUMN IF NOT EXISTS utm_hemisphere CHAR(1)
    CONSTRAINT chk_attendance_utm_hemisphere CHECK (utm_hemisphere IN ('N', 'S')),
  ADD COLUMN IF NOT EXISTS utm_easting NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS utm_northing NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS height_egm96 NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS place_name TEXT,
  ADD COLUMN IF NOT EXISTS place_detail JSONB,
  ADD COLUMN IF NOT EXISTS place_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS place_attempts SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN attendance_events.utm_easting IS
  'UTM easting in metres (WGS-1984, zone utm_zone, hemisphere utm_hemisphere), computed from lat/lng at insert.';
COMMENT ON COLUMN attendance_events.height_egm96 IS
  'Orthometric height in metres on the EGM96 geoid: altitude minus the 15-minute-grid undulation.';
COMMENT ON COLUMN attendance_events.place_name IS
  'Village/town, district, state from the reverse geocoder; NULL until resolved, and NULL for good once place_resolved_at is set without a name.';
COMMENT ON COLUMN attendance_events.place_detail IS
  'The full address object the geocoder returned, for the detail screen and for audit.';

-- The worker asks for the oldest positioned punches still without a place.
CREATE INDEX IF NOT EXISTS idx_attendance_events_place_pending
  ON attendance_events(server_timestamp)
  WHERE lat IS NOT NULL AND lng IS NOT NULL AND place_resolved_at IS NULL;
