-- 070: grid coordinates alongside the geographic ones on a control point.
--
-- A DGPS controller gives a fix both ways: latitude and longitude on the
-- ellipsoid, and a northing and easting on a projected grid. Survey drawings,
-- the LPM sheets and most of what the department hands back are in the grid;
-- latitude and longitude are what travels between systems.
--
-- Recording only one of them means somebody converts by hand every time the
-- other is needed, and a hand conversion with the wrong zone is a point in
-- the wrong state.
--
-- Deliberately stored rather than derived. Converting between the two is
-- deterministic only once the datum and projection are known, and an Indian
-- survey may be on WGS84 UTM or on the older Everest-based grids — computing
-- one from the other would assert a projection the survey may not be using.
-- What the controller displayed is what gets written down.

ALTER TABLE survey_village_gcps
  -- Metres on the projected grid. Six digits before the point covers any
  -- easting, seven any northing.
  ADD COLUMN IF NOT EXISTS easting_m  numeric(12,3),
  ADD COLUMN IF NOT EXISTS northing_m numeric(12,3),
  -- The grid those two are on: "44N", "43N", or whatever the survey records.
  -- Without it a northing and easting are two numbers, not a position.
  ADD COLUMN IF NOT EXISTS grid_zone  varchar(16);

-- A grid reference with no zone against it cannot be resolved to a place, and
-- a zone with no reference is noise. Either both or neither.
DO $$
BEGIN
  ALTER TABLE survey_village_gcps ADD CONSTRAINT chk_gcp_grid_pair
    CHECK (
      (easting_m IS NULL AND northing_m IS NULL)
      OR (easting_m IS NOT NULL AND northing_m IS NOT NULL AND btrim(coalesce(grid_zone,'')) <> '')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
