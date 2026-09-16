-- The survey workflow as it is actually run (§59.5, revised).
--
-- Five things the first cut of the module could not express:
--
--   * Ground truthing is checked before the drawing is vectorised, and GT QC
--     was missing. Without it a village whose GT had failed QC looked exactly
--     like one whose GT was simply done.
--   * The stages were independent. The work is a line: GT, then QC, then
--     vectorization, then records, then the LPM.
--   * Every stage needs remarks. "Two parcels disputed" is the reason a
--     village sits at QC for three weeks, and there was nowhere to write it.
--   * A village is worked by several employees, not one. A task carries a
--     single assignee, which is right for a task and wrong for a crew.
--   * Rovers were an integer. The question asked of them -- how many were
--     used today and how many sat idle -- cannot be answered by a count with
--     nothing to compare it against.

/* ------------------------------------------------------------- sequencing */

ALTER TABLE survey_stages
  -- The stage that must be complete before this one starts. A single
  -- predecessor rather than a graph, because that is what the work is.
  ADD COLUMN IF NOT EXISTS requires_stage_id uuid REFERENCES survey_stages(id),
  -- Daily progress is counted against ground truthing only; the later stages
  -- are done or they are not.
  ADD COLUMN IF NOT EXISTS tracks_daily_progress boolean NOT NULL DEFAULT false;

ALTER TABLE survey_village_stages
  ADD COLUMN IF NOT EXISTS remarks text;

/* ------------------------------------------------------------------ crew */

-- Several employees work one village at one stage. Held apart from the task's
-- assignee: a task has one owner, which is right for a task and wrong for a
-- crew of six.
CREATE TABLE IF NOT EXISTS survey_crew (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  stage_id          uuid NOT NULL REFERENCES survey_stages(id),
  employee_id       uuid NOT NULL REFERENCES employees(id),
  assigned_on       date NOT NULL DEFAULT CURRENT_DATE,
  -- Null while they are still on it. Kept rather than deleted so that who
  -- surveyed a village last season is still answerable.
  released_on       date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  UNIQUE (survey_village_id, stage_id, employee_id)
);

DO $$
BEGIN
  ALTER TABLE survey_crew ADD CONSTRAINT chk_survey_crew_dates
    CHECK (released_on IS NULL OR released_on >= assigned_on);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_survey_crew_village ON survey_crew(survey_village_id);
CREATE INDEX IF NOT EXISTS idx_survey_crew_employee ON survey_crew(org_id, employee_id);

/* ---------------------------------------------------------------- rovers */

-- Rovers are assets, not a number. Allocating one names the instrument, which
-- is what makes "nineteen idle" a fact somebody can act on rather than
-- arithmetic on two guesses.
CREATE TABLE IF NOT EXISTS survey_rover_allocations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  asset_id          uuid NOT NULL REFERENCES assets(id),
  allocated_on      date NOT NULL,
  released_on       date,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id)
);

DO $$
BEGIN
  ALTER TABLE survey_rover_allocations ADD CONSTRAINT chk_survey_rover_dates
    CHECK (released_on IS NULL OR released_on >= allocated_on);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One instrument cannot be in two villages at once. An overlapping allocation
-- would double-count it in the allocated total and make the idle figure --
-- the whole point of the table -- silently wrong.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Guarded on existence rather than by catching an exception: an EXCLUDE
-- constraint creates an index behind it, so a re-run raises duplicate_table
-- rather than duplicate_object and the obvious handler does not catch it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'excl_survey_rover_overlap'
      AND conrelid = 'survey_rover_allocations'::regclass
  ) THEN
    ALTER TABLE survey_rover_allocations ADD CONSTRAINT excl_survey_rover_overlap
      EXCLUDE USING gist (
        asset_id WITH =,
        daterange(allocated_on, COALESCE(released_on, 'infinity'::date), '[]') WITH &&
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_survey_rover_village
  ON survey_rover_allocations(survey_village_id);
CREATE INDEX IF NOT EXISTS idx_survey_rover_dates
  ON survey_rover_allocations(org_id, allocated_on, released_on);

/* --------------------------------------------------------- daily rovers */

ALTER TABLE survey_entries
  -- What the crew reported actually using. `dgps_rovers` already held this;
  -- the column is renamed in meaning only, and the comment is the rename.
  ADD COLUMN IF NOT EXISTS rovers_idle integer;

COMMENT ON COLUMN survey_entries.dgps_rovers IS
  'Rovers the crew reported using on this date. Idle is derived against the allocations.';

/* -------------------------------------------------------------- the seed */

-- GT QC, and the ordering.
INSERT INTO survey_stages (org_id, code, label, display_order)
SELECT o.id, 'GT_QC', 'GT quality check', 20 FROM organizations o
ON CONFLICT (org_id, code) DO NOTHING;

-- Re-space the existing stages so QC has room between GT and vectorization.
UPDATE survey_stages SET display_order = 10 WHERE code = 'GROUND_TRUTHING';
UPDATE survey_stages SET display_order = 20 WHERE code = 'GT_QC';
UPDATE survey_stages SET display_order = 30 WHERE code = 'VECTORIZATION';
UPDATE survey_stages SET display_order = 40 WHERE code = 'RECORDS_PREPARATION';
UPDATE survey_stages SET display_order = 50 WHERE code = 'LPM_GENERATION';

UPDATE survey_stages SET tracks_daily_progress = true WHERE code = 'GROUND_TRUTHING';

-- Chain each stage to the one before it, within each organisation.
UPDATE survey_stages s SET requires_stage_id = p.id
FROM survey_stages p
WHERE p.org_id = s.org_id
  AND (
    (s.code = 'GT_QC'               AND p.code = 'GROUND_TRUTHING') OR
    (s.code = 'VECTORIZATION'       AND p.code = 'GT_QC') OR
    (s.code = 'RECORDS_PREPARATION' AND p.code = 'VECTORIZATION') OR
    (s.code = 'LPM_GENERATION'      AND p.code = 'RECORDS_PREPARATION')
  );
