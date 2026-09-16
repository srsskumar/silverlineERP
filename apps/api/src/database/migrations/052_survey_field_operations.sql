-- Field operations for the land survey (§59, phases 1-3 of the specification).
--
-- The central principle the specification states is that daily operational
-- activity is the source of truth for project progress. Five things stood
-- between the module and that:
--
--   * Rovers were counted, not named, on a day's return. "How many rovers
--     were idle and why" cannot be answered by a number.
--   * There was nowhere to say why a day produced little.
--   * A village's stages held their current state and no history, so
--     "where is time being spent" had no data behind it.
--   * The pipeline stopped at LPM generation; the work runs on through
--     vectorization QC, submission and rework.
--   * An employee belonged to no project, so project-scoped visibility had
--     nothing to scope by.

/* ------------------------------------------------- the rest of the pipeline */

-- Vectorization QC, submission and rework. Rework is deliberately a stage
-- rather than a flag: a village that comes back has a start and an end like
-- any other work, and the history must show it happened rather than quietly
-- reopening the stage that was already signed off.
INSERT INTO survey_stages (org_id, code, label, display_order)
SELECT o.id, v.code, v.label, v.ord
FROM organizations o
CROSS JOIN (VALUES
  ('VECTORIZATION_QC', 'Vectorization QC', 60),
  ('SUBMISSION',       'Submission of deliverables', 70),
  ('REWORK',           'Rework', 80)
) AS v(code, label, ord)
ON CONFLICT (org_id, code) DO NOTHING;

-- Re-space so the pipeline reads in the order the work runs.
UPDATE survey_stages SET display_order = 10 WHERE code = 'GROUND_TRUTHING';
UPDATE survey_stages SET display_order = 20 WHERE code = 'GT_QC';
UPDATE survey_stages SET display_order = 30 WHERE code = 'VECTORIZATION';
UPDATE survey_stages SET display_order = 40 WHERE code = 'VECTORIZATION_QC';
UPDATE survey_stages SET display_order = 50 WHERE code = 'RECORDS_PREPARATION';
UPDATE survey_stages SET display_order = 60 WHERE code = 'LPM_GENERATION';
UPDATE survey_stages SET display_order = 70 WHERE code = 'SUBMISSION';
UPDATE survey_stages SET display_order = 80 WHERE code = 'REWORK';

UPDATE survey_stages s SET requires_stage_id = p.id
FROM survey_stages p
WHERE p.org_id = s.org_id AND (
  (s.code = 'GT_QC'               AND p.code = 'GROUND_TRUTHING') OR
  (s.code = 'VECTORIZATION'       AND p.code = 'GT_QC') OR
  (s.code = 'VECTORIZATION_QC'    AND p.code = 'VECTORIZATION') OR
  (s.code = 'RECORDS_PREPARATION' AND p.code = 'VECTORIZATION_QC') OR
  (s.code = 'LPM_GENERATION'      AND p.code = 'RECORDS_PREPARATION') OR
  (s.code = 'SUBMISSION'          AND p.code = 'LPM_GENERATION')
);

-- Rework has no predecessor: it is entered from wherever the work failed, not
-- reached in sequence.
UPDATE survey_stages SET requires_stage_id = NULL WHERE code = 'REWORK';

/* --------------------------------------------------------- stage history */

-- Every stage movement, kept. The specification asks where time is being
-- spent and where the bottlenecks are; the current state of a stage cannot
-- answer either, because it has forgotten how long it sat in the state before.
CREATE TABLE IF NOT EXISTS survey_stage_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  stage_id          uuid NOT NULL REFERENCES survey_stages(id),
  from_state        varchar(20),
  to_state          varchar(20) NOT NULL,
  remarks           text,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  changed_by        uuid REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_survey_stage_history_village
  ON survey_stage_history(survey_village_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_survey_stage_history_org
  ON survey_stage_history(org_id, changed_at);

/* ---------------------------------------------------- rovers, one by one */

-- A day's return, per rover. The specification says the update is against
-- each rover, and it is right: "eleven of thirty were idle" is a number,
-- while "R101 idle, weather; R102 idle, rover fault" is something to act on.
CREATE TABLE IF NOT EXISTS survey_entry_rovers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  entry_id     uuid NOT NULL REFERENCES survey_entries(id) ON DELETE CASCADE,
  asset_id     uuid NOT NULL REFERENCES assets(id),
  status       varchar(16) NOT NULL
    CONSTRAINT chk_survey_rover_day_status CHECK (status IN ('UTILIZED', 'IDLE')),
  -- Mandatory when idle. Enforced below rather than by convention, because an
  -- idle count with no reasons behind it is not a finding anybody can use.
  idle_reason  varchar(32),
  remarks      text,
  -- What this instrument covered, so a rover's output is answerable.
  area_ac      numeric(14,4),
  employee_id  uuid REFERENCES employees(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One row per rover per day. Two would double it in both the utilisation
  -- and the idle figures.
  UNIQUE (entry_id, asset_id)
);

DO $$
BEGIN
  ALTER TABLE survey_entry_rovers ADD CONSTRAINT chk_survey_rover_idle_reason
    CHECK (status <> 'IDLE' OR idle_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  -- "Other" with nothing written is the same as no reason at all.
  ALTER TABLE survey_entry_rovers ADD CONSTRAINT chk_survey_rover_other_remarks
    CHECK (idle_reason <> 'OTHER' OR (remarks IS NOT NULL AND btrim(remarks) <> ''));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE survey_entry_rovers ADD CONSTRAINT chk_survey_rover_in_use_no_reason
    CHECK (status <> 'UTILIZED' OR idle_reason IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_survey_entry_rovers_asset
  ON survey_entry_rovers(org_id, asset_id);

/* --------------------------------------------------- why a day was thin */

ALTER TABLE survey_entries
  ADD COLUMN IF NOT EXISTS low_progress_reason varchar(32),
  ADD COLUMN IF NOT EXISTS low_progress_remarks text,
  -- Where the crew punched in and out, and when. Kept on the entry as well as
  -- on attendance because the day's return is the record a supervisor reads.
  ADD COLUMN IF NOT EXISTS punch_in_at  timestamptz,
  ADD COLUMN IF NOT EXISTS punch_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS punch_in_lat  numeric(10,7),
  ADD COLUMN IF NOT EXISTS punch_in_lng  numeric(10,7),
  ADD COLUMN IF NOT EXISTS punch_out_lat numeric(10,7),
  ADD COLUMN IF NOT EXISTS punch_out_lng numeric(10,7);

DO $$
BEGIN
  ALTER TABLE survey_entries ADD CONSTRAINT chk_survey_entry_low_other
    CHECK (low_progress_reason <> 'OTHER'
        OR (low_progress_remarks IS NOT NULL AND btrim(low_progress_remarks) <> ''));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

/* ------------------------------------------------- the programme and village */

ALTER TABLE survey_projects
  -- Below this, a day is low progress and wants a reason. Per programme,
  -- because a hill district and a delta district are not comparable.
  ADD COLUMN IF NOT EXISTS low_progress_threshold_ac numeric(10,2),
  -- How long a stage may sit before it counts as a bottleneck.
  ADD COLUMN IF NOT EXISTS stage_sla_days integer NOT NULL DEFAULT 14;

ALTER TABLE survey_projects DROP CONSTRAINT IF EXISTS chk_survey_project_status;
ALTER TABLE survey_projects ADD CONSTRAINT chk_survey_project_status
  CHECK (status IN ('DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'DISABLED', 'CLOSED'));

-- CLOSED is kept alongside COMPLETED so rows written before this migration
-- stay valid. New programmes use the specification's vocabulary.

ALTER TABLE survey_villages
  -- Entered when ground truthing starts, and editable afterwards. Separate
  -- from the projected date, which is arithmetic and belongs to nobody.
  ADD COLUMN IF NOT EXISTS expected_completion_on date,
  -- A hold or a rework decision. Null means the status follows the stages.
  ADD COLUMN IF NOT EXISTS status_override varchar(20)
    CONSTRAINT chk_survey_village_override
    CHECK (status_override IS NULL OR status_override IN ('ON_HOLD', 'REWORK')),
  ADD COLUMN IF NOT EXISTS status_remarks text,
  ADD COLUMN IF NOT EXISTS planned_start_on date;

/* ------------------------------------------- who is on which programme */

-- An employee belongs to several programmes and sees only those. Without this
-- there was nothing for project-scoped visibility to scope by.
CREATE TABLE IF NOT EXISTS survey_project_employees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_project_id uuid NOT NULL REFERENCES survey_projects(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES employees(id),
  -- What they do on this programme. A person may ground-truth one and run QC
  -- on another.
  project_role      varchar(32) NOT NULL DEFAULT 'GT_USER'
    CONSTRAINT chk_survey_project_role
    CHECK (project_role IN ('GT_USER','QC_USER','QGIS_USER','TEAM_LEAD','PROJECT_MANAGER')),
  assigned_on       date NOT NULL DEFAULT CURRENT_DATE,
  released_on       date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  UNIQUE (survey_project_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_survey_project_employees_employee
  ON survey_project_employees(org_id, employee_id);

/* ----------------------------------------------------------- permissions */

INSERT INTO permissions (code, description, module) VALUES
  ('survey.forecast',  'See projected completion dates and pace forecasts', 'survey'),
  ('survey.assign',    'Assign employees and rovers to survey work',        'survey'),
  ('survey.qc',        'Work the QC stages',                                'survey'),
  ('survey.vectorize', 'Work the vectorization stages',                     'survey')
ON CONFLICT (code) DO NOTHING;

-- A forecast is management information. The specification is explicit that a
-- GT user does not see it, so it is its own permission rather than folded
-- into survey.read.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.permission
FROM roles r
JOIN (VALUES
  ('SUPER_ADMIN','survey.forecast'),('SUPER_ADMIN','survey.assign'),
  ('SUPER_ADMIN','survey.qc'),('SUPER_ADMIN','survey.vectorize'),
  ('ADMIN','survey.forecast'),('ADMIN','survey.assign'),
  ('ADMIN','survey.qc'),('ADMIN','survey.vectorize'),
  ('PROJECT_MANAGER','survey.forecast'),('PROJECT_MANAGER','survey.assign'),
  ('PROJECT_MANAGER','survey.qc'),('PROJECT_MANAGER','survey.vectorize'),
  ('TEAM_LEAD','survey.assign'),
  ('AUDITOR','survey.forecast')
) AS g(role_code, permission) ON g.role_code = r.code
ON CONFLICT (role_id, permission_code) DO NOTHING;
