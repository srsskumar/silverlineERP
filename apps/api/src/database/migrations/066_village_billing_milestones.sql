-- 066: what has been submitted for billing, village by village.
--
-- A resurvey contract releases a village's value in three claims: half when
-- ground truthing is signed off, thirty per cent at records, the last fifth on
-- final submission. The office needs to answer "which villages have we claimed
-- the first milestone on and not the second", and until now that answer lived
-- in somebody's spreadsheet.
--
-- One row per claim, not a column per milestone: a fourth milestone on a later
-- contract is then data, not a migration.

CREATE TABLE IF NOT EXISTS survey_village_billing (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  -- 1, 2, 3 in the order the contract releases them.
  milestone         smallint NOT NULL
    CONSTRAINT chk_village_billing_milestone CHECK (milestone BETWEEN 1 AND 9),
  -- The share of the village's value this claim releases. Defaulted from the
  -- milestone but stored, because the contract governs: a later programme may
  -- split 40/40/20 and the rows written under this one must not move.
  percent           numeric(5,2) NOT NULL
    CONSTRAINT chk_village_billing_percent CHECK (percent > 0 AND percent <= 100),
  status            varchar(16) NOT NULL DEFAULT 'SUBMITTED'
    CONSTRAINT chk_village_billing_status
    CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','PAID')),
  submitted_on      date NOT NULL DEFAULT CURRENT_DATE,
  -- When the department accepted or paid it. Null until they do.
  decided_on        date,
  -- The department's file or claim number, as written on the covering letter.
  reference_no      varchar(64),
  -- The extent claimed, which is what was surveyed and need not equal the
  -- extent in the revenue record.
  extent_ac         numeric(14,4)
    CONSTRAINT chk_village_billing_extent CHECK (extent_ac IS NULL OR extent_ac >= 0),
  remarks           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  version           integer NOT NULL DEFAULT 1,
  -- A milestone is claimed once per village. A second claim is an amendment
  -- of the first, not a new row, or the percentages stop adding to a hundred.
  UNIQUE (survey_village_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_village_billing_village
  ON survey_village_billing(org_id, survey_village_id);

-- The list the office actually pulls: everything claimed in a date window,
-- newest first.
CREATE INDEX IF NOT EXISTS idx_village_billing_submitted
  ON survey_village_billing(org_id, submitted_on DESC);
