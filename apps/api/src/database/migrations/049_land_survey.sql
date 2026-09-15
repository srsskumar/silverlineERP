-- Land survey progress (§59).
--
-- Replaces the Excel workbook a DGPS cadastral resurvey is run from. Three
-- things in that sheet produce wrong numbers at scale, and the schema is
-- shaped by them:
--
--   * `Today` and `Cumulative` are both typed in. Nothing here stores a
--     cumulative; it is SUM(today) over the entries, which also makes
--     backdated entry correct without recomputation.
--   * One village entered twice for one day doubles every total downstream,
--     so that is a unique constraint rather than a convention.
--   * A percentage needs a denominator. Extent-based measures divide by the
--     village extent; the rest divide by a target recorded per village, and
--     where there is none the percentage is reported as unknown.

/* ------------------------------------------------------------ geography */

-- The survey master list is District -> Division -> Mandal -> Village. The
-- organisation's geography is District -> Mandal -> Village -> Site, and
-- geo-fences, employee scoping and holiday scoping already hang off it.
--
-- A division tier is therefore added to the existing tree rather than a
-- second tree being built beside it: two notions of place is how a village
-- ends up in one mandal for attendance and another for reporting.
--
-- The tier is optional. Every mandal already recorded has a district for a
-- parent, and none of them should break.
ALTER TABLE org_units DROP CONSTRAINT IF EXISTS chk_org_unit_type;
ALTER TABLE org_units ADD CONSTRAINT chk_org_unit_type
  CHECK (type IN ('district', 'division', 'mandal', 'village', 'site'));

ALTER TABLE geo_fences DROP CONSTRAINT IF EXISTS chk_geo_fence_scope;
ALTER TABLE geo_fences ADD CONSTRAINT chk_geo_fence_scope
  CHECK (scope_type IN ('district', 'division', 'mandal', 'village', 'site'));

-- Codes from the revenue department's own list. Reconciliation is done on
-- these, not on names: two villages called Ramapuram in one district is
-- ordinary, and the old village code is how the previous records are matched.
ALTER TABLE org_units
  ADD COLUMN IF NOT EXISTS source_code     VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_code_old VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_org_units_source_code
  ON org_units(org_id, type, source_code) WHERE source_code IS NOT NULL;

/* -------------------------------------------------------------- project */

CREATE TABLE IF NOT EXISTS survey_projects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  code                 varchar(64) NOT NULL,
  name                 varchar(255) NOT NULL,
  -- Optional: a survey programme may be run against an ordinary project when
  -- its cost and billing are to be tracked, and need not be.
  project_id           uuid REFERENCES projects(id),
  started_on           date,
  target_completion_on date,
  status               varchar(20) NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT chk_survey_project_status CHECK (status IN ('ACTIVE', 'ON_HOLD', 'CLOSED')),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id),
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);

/* ------------------------------------------------------------- measures */

-- Defined rather than hard-coded as columns: the requirement is explicit that
-- more get added on the fly, and a new measure should be a row, not a
-- migration and a deployment.
CREATE TABLE IF NOT EXISTS survey_measures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  code          varchar(64) NOT NULL,
  label         varchar(255) NOT NULL,
  -- The heading this sits under on the entry form, mirroring the merged
  -- header cells of the sheet it replaces.
  group_label   varchar(255),
  unit          varchar(16) NOT NULL
    CONSTRAINT chk_survey_measure_unit CHECK (unit IN ('POINTS','PARCELS','ACRES','COUNT')),
  -- What completion is divided by. EXTENT uses the village's own extent;
  -- TARGET uses a figure recorded per village; NONE means the quantity does
  -- not express progress towards anything and gets no percentage.
  basis         varchar(16) NOT NULL DEFAULT 'NONE'
    CONSTRAINT chk_survey_measure_basis CHECK (basis IN ('EXTENT','TARGET','NONE')),
  display_order integer NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS survey_stages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  code          varchar(64) NOT NULL,
  label         varchar(255) NOT NULL,
  display_order integer NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

/* ------------------------------------------------------------- villages */

CREATE TABLE IF NOT EXISTS survey_villages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_project_id uuid NOT NULL REFERENCES survey_projects(id) ON DELETE CASCADE,
  village_id        uuid NOT NULL REFERENCES org_units(id),
  -- The denominator for every extent-based percentage, from the master list.
  -- Square kilometres are derived on read: two columns holding one quantity
  -- in different units disagree the moment either is edited.
  total_extent_ac   numeric(14,4),
  dgps_base         integer NOT NULL DEFAULT 0,
  dgps_rovers       integer NOT NULL DEFAULT 0,
  teams             integer NOT NULL DEFAULT 0,
  vill_code_old     varchar(64),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  version           integer NOT NULL DEFAULT 1,
  -- A village appears once in a programme. Twice would double its extent in
  -- every denominator above it.
  UNIQUE (survey_project_id, village_id)
);

CREATE INDEX IF NOT EXISTS idx_survey_villages_project
  ON survey_villages(org_id, survey_project_id);

-- The target a target-based measure is divided by, per village. Held apart
-- from the village row because measures are added on the fly and a column per
-- measure is exactly what this module exists to avoid.
CREATE TABLE IF NOT EXISTS survey_targets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  measure_id        uuid NOT NULL REFERENCES survey_measures(id),
  target_quantity   numeric(14,4) NOT NULL
    CONSTRAINT chk_survey_target_positive CHECK (target_quantity > 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  UNIQUE (survey_village_id, measure_id)
);

CREATE TABLE IF NOT EXISTS survey_village_stages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  stage_id          uuid NOT NULL REFERENCES survey_stages(id),
  state             varchar(20) NOT NULL DEFAULT 'NOT_STARTED'
    CONSTRAINT chk_survey_stage_state
    CHECK (state IN ('NOT_STARTED','IN_PROGRESS','COMPLETED','ON_HOLD')),
  started_on        date,
  completed_on      date,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  UNIQUE (survey_village_id, stage_id)
);

DO $$
BEGIN
  ALTER TABLE survey_village_stages ADD CONSTRAINT chk_survey_stage_dates
    CHECK (started_on IS NULL OR completed_on IS NULL OR completed_on >= started_on);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  -- A stage reported complete with no completion date cannot appear on the
  -- summary sheet, which reports the date.
  ALTER TABLE survey_village_stages ADD CONSTRAINT chk_survey_stage_completed
    CHECK (state <> 'COMPLETED' OR completed_on IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

/* ---------------------------------------------------------- daily entry */

CREATE TABLE IF NOT EXISTS survey_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_project_id uuid NOT NULL REFERENCES survey_projects(id) ON DELETE CASCADE,
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  entry_date        date NOT NULL,
  teams_deployed    integer NOT NULL DEFAULT 0,
  dgps_base         integer NOT NULL DEFAULT 0,
  dgps_rovers       integer NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  version           integer NOT NULL DEFAULT 1,
  -- One row per village per day, as on the sheet. A second row for the same
  -- day would double that day's contribution to every cumulative figure, and
  -- nothing downstream would show the error.
  UNIQUE (survey_village_id, entry_date)
);

-- The query every report runs: entries for a programme within a date range.
CREATE INDEX IF NOT EXISTS idx_survey_entries_date
  ON survey_entries(org_id, survey_project_id, entry_date);

CREATE TABLE IF NOT EXISTS survey_entry_values (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id),
  entry_id   uuid NOT NULL REFERENCES survey_entries(id) ON DELETE CASCADE,
  measure_id uuid NOT NULL REFERENCES survey_measures(id),
  -- Today's figure only. There is deliberately no cumulative column.
  quantity   numeric(14,4) NOT NULL DEFAULT 0
    CONSTRAINT chk_survey_value_sign CHECK (quantity >= 0),
  UNIQUE (entry_id, measure_id)
);

CREATE INDEX IF NOT EXISTS idx_survey_entry_values_measure
  ON survey_entry_values(measure_id);

/* ----------------------------------------------------------------- seed */

-- The measures the existing sheet already keeps. Seeded so that the first
-- user does not invent "Village Boundary" while the second invents "village
-- boundary points" and the report can no longer add them together.
INSERT INTO survey_measures (org_id, code, label, group_label, unit, basis, display_order)
SELECT o.id, m.code, m.label, m.group_label, m.unit, m.basis, m.display_order
FROM organizations o
CROSS JOIN (VALUES
  ('VILLAGE_BOUNDARY_POINTS','Points','Village boundary','POINTS','TARGET',10),
  ('HABITATION_BOUNDARY_POINTS','Points','Habitation boundary','POINTS','TARGET',20),
  ('GOVT_LAND_PARCELS','Land parcels arrived','Government lands','PARCELS','TARGET',30),
  ('GOVT_LAND_POINTS','Points','Government lands','POINTS','NONE',31),
  ('GOVT_LAND_EXTENT_AC','Extent','Government lands','ACRES','EXTENT',32),
  ('PRIVATE_LAND_PARCELS','Land parcels arrived','Private lands','PARCELS','TARGET',40),
  ('PRIVATE_LAND_POINTS','Points','Private lands','POINTS','NONE',41),
  ('PRIVATE_LAND_EXTENT_AC','Extent','Private lands','ACRES','EXTENT',42),
  ('RECORDS_PREPARED','Records prepared','Preparation of records','COUNT','TARGET',50),
  ('NOTICES_9_2_SERVED','9(2) notices served','Notices','COUNT','TARGET',60),
  ('LPMS_GENERATED','LPMs generated','Output','COUNT','TARGET',70)
) AS m(code,label,group_label,unit,basis,display_order)
ON CONFLICT (org_id, code) DO NOTHING;

-- Ground truthing and vectorization are states, not quantities: counting them
-- would say nothing. They carry dates because the summary reports both.
INSERT INTO survey_stages (org_id, code, label, display_order)
SELECT o.id, s.code, s.label, s.display_order
FROM organizations o
CROSS JOIN (VALUES
  ('GROUND_TRUTHING','Ground truthing',10),
  ('VECTORIZATION','Vectorization',20),
  ('RECORDS_PREPARATION','Records preparation',30),
  ('LPM_GENERATION','LPM generation',40)
) AS s(code,label,display_order)
ON CONFLICT (org_id, code) DO NOTHING;

/* ---------------------------------------------------------- permissions */

INSERT INTO permissions (code, description, module) VALUES
  ('survey.read',   'See survey progress and reports',                  'survey'),
  ('survey.enter',  'Record daily survey progress',                     'survey'),
  ('survey.manage', 'Maintain the village work list and the measures',  'survey'),
  ('survey.target', 'Set the targets completion is measured against',   'survey')
ON CONFLICT (code) DO NOTHING;

-- A crew records progress and deliberately cannot set the target its own
-- completion is measured against.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.permission
FROM roles r
JOIN (VALUES
  ('SUPER_ADMIN','survey.read'),('SUPER_ADMIN','survey.enter'),
  ('SUPER_ADMIN','survey.manage'),('SUPER_ADMIN','survey.target'),
  ('ADMIN','survey.read'),('ADMIN','survey.enter'),
  ('ADMIN','survey.manage'),('ADMIN','survey.target'),
  ('PROJECT_MANAGER','survey.read'),('PROJECT_MANAGER','survey.enter'),
  ('PROJECT_MANAGER','survey.manage'),('PROJECT_MANAGER','survey.target'),
  ('TEAM_LEAD','survey.read'),('TEAM_LEAD','survey.enter'),
  ('EMPLOYEE','survey.read'),('EMPLOYEE','survey.enter'),
  ('AUDITOR','survey.read'),
  ('HR_MANAGER','survey.read'),
  ('INVENTORY_MANAGER','survey.read'),
  ('BID_TENDER_MANAGER','survey.read'),
  ('SALES_BD_EXECUTIVE','survey.read'),
  ('CLIENT_VIEWER','survey.read')
) AS g(role_code, permission) ON g.role_code = r.code
ON CONFLICT (role_id, permission_code) DO NOTHING;
