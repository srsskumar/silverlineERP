-- 067: who was allotted to ground truthing, and who actually turned up.
--
-- Ground truthing is done by our crew walking the boundaries alongside
-- government staff — the village revenue officer, the surveyor, whoever the
-- mandal sends. The contract is staffed on the assumption that both sides
-- field the agreed numbers, and when the department's people do not turn up
-- the crew stands in the village doing nothing at our cost.
--
-- That gap was invisible. The daily return recorded teams and rovers; it did
-- not record how many people of either kind were actually there, so "we lost
-- nine days in Koyyuru waiting for the VRO" was something a supervisor knew
-- and nothing could show.
--
-- Two numbers on the village (what was allotted when it started) and two on
-- each day's return (who came). The gap between them is the finding.
--
-- Ground truthing only. No other stage is staffed jointly, and columns that
-- mean nothing for six stages out of seven invite figures that mean nothing.

ALTER TABLE survey_villages
  -- Agreed when ground truthing starts: the department's people, and ours.
  ADD COLUMN IF NOT EXISTS gt_govt_staff_allocated integer
    CONSTRAINT chk_gt_govt_staff_allocated
    CHECK (gt_govt_staff_allocated IS NULL OR gt_govt_staff_allocated >= 0),
  ADD COLUMN IF NOT EXISTS gt_crew_allocated integer
    CONSTRAINT chk_gt_crew_allocated
    CHECK (gt_crew_allocated IS NULL OR gt_crew_allocated >= 0);

ALTER TABLE survey_entries
  -- Who was actually in the village that day. Null means the question was
  -- not asked — returns filed before this existed, and days on stages that
  -- are not ground truthing. Zero means nobody came, which is a different
  -- fact and the one worth counting.
  ADD COLUMN IF NOT EXISTS govt_staff_present integer
    CONSTRAINT chk_entry_govt_staff_present
    CHECK (govt_staff_present IS NULL OR govt_staff_present >= 0),
  ADD COLUMN IF NOT EXISTS crew_present integer
    CONSTRAINT chk_entry_crew_present
    CHECK (crew_present IS NULL OR crew_present >= 0);

-- The report that matters is "days where the department fielded fewer than
-- agreed", which scans a programme's returns over a window.
CREATE INDEX IF NOT EXISTS idx_survey_entries_staffing
  ON survey_entries(org_id, survey_project_id, entry_date)
  WHERE govt_staff_present IS NOT NULL OR crew_present IS NOT NULL;
