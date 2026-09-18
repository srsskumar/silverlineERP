-- 068: the totals somebody stands behind, when a village is finished.
--
-- Every figure in this module is the sum of daily returns, and that is the
-- right default: it is built from what the crews actually recorded, day by
-- day, with a trail behind each number.
--
-- It is not, however, what goes to the department. At handover the village is
-- recounted — parcels merge, a boundary is re-walked, two days' returns turn
-- out to have double-counted a hamlet — and the certified figure differs from
-- the running sum. Until now the only ways to reconcile that were to amend
-- historical returns until they added up to the right answer, which destroys
-- the daily record, or to keep the real number in a spreadsheet.
--
-- So: an explicit, reasoned, audited override per measure per village. It
-- never replaces the daily sum — both are reported, and the difference is
-- visible — because a figure that silently overwrote the record it came from
-- would be the spreadsheet again, just inside the database.

CREATE TABLE IF NOT EXISTS survey_village_finals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_village_id uuid NOT NULL REFERENCES survey_villages(id) ON DELETE CASCADE,
  measure_id        uuid NOT NULL REFERENCES survey_measures(id),
  -- What the village is certified at. Not a delta: an adjustment would have
  -- to be re-derived every time a daily return was corrected behind it, and
  -- the certified figure is a statement about the village, not about the sum.
  quantity          numeric(14,4) NOT NULL
    CONSTRAINT chk_village_final_quantity CHECK (quantity >= 0),
  -- Mandatory. A number that differs from the record with no explanation is
  -- exactly what this is meant to stop.
  reason            text NOT NULL
    CONSTRAINT chk_village_final_reason CHECK (btrim(reason) <> ''),
  certified_by      uuid REFERENCES users(id),
  certified_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  version           integer NOT NULL DEFAULT 1,
  -- One certified figure per measure per village. A second would leave the
  -- reader to choose, which is the problem restated.
  UNIQUE (survey_village_id, measure_id)
);

CREATE INDEX IF NOT EXISTS idx_village_finals_village
  ON survey_village_finals(org_id, survey_village_id);

/* ----------------------------------------------------------- permissions */

-- Certifying is not managing. A team lead closes out the villages they ran
-- and does not set targets or move villages between programmes; the
-- specification keeps those apart and so does this.
INSERT INTO permissions (code, description, module) VALUES
  ('survey.certify', 'Certify a finished village''s totals', 'survey')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'survey.certify'
FROM roles r
WHERE r.code IN ('SUPER_ADMIN', 'ADMIN', 'PROJECT_MANAGER', 'TEAM_LEAD')
ON CONFLICT (role_id, permission_code) DO NOTHING;
