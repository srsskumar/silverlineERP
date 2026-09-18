-- 069: the ground control points a village was surveyed from.
--
-- A GCP is the fixed, known point a DGPS base is set over; every measurement
-- in the village is relative to it. Establishing one is a one-time job done
-- before ground truthing starts, and there is usually exactly one — but a
-- large or awkward village needs two or three, and which reading came from
-- which matters when a boundary is later disputed.
--
-- Until now the coordinates lived in the surveyor's notebook and, if anybody
-- was lucky, in a WhatsApp message. Re-establishing a control point because
-- nobody wrote it down is a day's work with a base station.

CREATE TABLE IF NOT EXISTS survey_village_gcps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  -- What it is called on the ground and in the records: a pillar number, a
  -- benchmark reference, or just GCP-1. Named because a village with three
  -- of them needs to say which.
  point_code        varchar(64) NOT NULL
    CONSTRAINT chk_gcp_point_code CHECK (btrim(point_code) <> ''),
  -- Degrees, seven decimal places: about a centimetre, which is finer than
  -- any DGPS fix and leaves nothing to round away.
  latitude          numeric(10,7) NOT NULL
    CONSTRAINT chk_gcp_latitude CHECK (latitude BETWEEN -90 AND 90),
  longitude         numeric(10,7) NOT NULL
    CONSTRAINT chk_gcp_longitude CHECK (longitude BETWEEN -180 AND 180),
  -- Metres. Optional because a horizontal control point is still a control
  -- point, but recorded where it is known: a GCP without a height is half of
  -- one.
  elevation_m       numeric(10,3),
  -- How the point was fixed, in the surveyor's words: which benchmark it was
  -- tied to, how long the base observed, what the PDOP was. This is the part
  -- somebody needs two years later and the part nobody writes down.
  remarks           text,
  established_on    date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  version           integer NOT NULL DEFAULT 1,
  -- One row per named point per village. The same name twice is a typo or a
  -- second reading of the same pillar, and both want correcting rather than
  -- storing side by side.
  UNIQUE (survey_village_id, point_code)
);

CREATE INDEX IF NOT EXISTS idx_village_gcps_village
  ON survey_village_gcps(org_id, survey_village_id);
