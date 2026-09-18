-- Kit follows the person (§note 11).
--
-- A rover is issued to somebody in the asset register, and it goes where they
-- go. The survey module made that a second, separate job: allocate the crew
-- to the village, then allocate each of their instruments to the same village
-- by hand. With crews moving to the next village as each one finishes ground
-- truthing, that is the same manual work again every few days, per person,
-- per instrument — and the day it is forgotten the village reports rovers it
-- has and utilisation nobody can explain.
--
-- The allocation rows stay: they carry dates and history, and every
-- utilisation figure is built on them. What changes is that nobody types
-- them.

ALTER TABLE survey_rover_allocations
  ADD COLUMN IF NOT EXISTS assigned_via_employee_id uuid REFERENCES employees(id);

COMMENT ON COLUMN survey_rover_allocations.assigned_via_employee_id IS
  'The crew member whose posting brought this instrument to the village. '
  'Null means somebody allocated it to the village directly, and a crew '
  'member leaving must not take it with them.';

CREATE INDEX IF NOT EXISTS idx_survey_rover_alloc_via_employee
  ON survey_rover_allocations(org_id, assigned_via_employee_id)
  WHERE assigned_via_employee_id IS NOT NULL AND released_on IS NULL;
