-- Punching in and out against a village (§59, phase 2 of the specification).
--
-- Attendance already captures what the specification asks for at the punch:
-- the time, the position, the accuracy, the geofence result and the device.
-- None of that is rebuilt here. What was missing is which village the person
-- punched in *for*, and the link between punching out and the day's return.

ALTER TABLE attendance_events
  -- The village this punch belongs to. Nullable: an office day, a training
  -- day and every punch recorded before this existed have no village, and
  -- backfilling a guess would be worse than the gap.
  ADD COLUMN IF NOT EXISTS survey_village_id uuid REFERENCES survey_villages(id),
  -- Why the day's return was not filed at punch-out.
  --
  -- The specification says punch-out should require the daily progress
  -- submission. Requiring it absolutely is the wrong trade: a crew member
  -- with a dead battery or no signal could not punch out at all, attendance
  -- would show them still on site, and corrupt attendance is worse than a
  -- late progress return. So the punch is refused *until* they either file
  -- the return or say why they cannot -- the same shape as the idle-rover
  -- rule, and the omission is recorded rather than silent.
  ADD COLUMN IF NOT EXISTS progress_deferred_reason varchar(32),
  ADD COLUMN IF NOT EXISTS progress_deferred_remarks text;

DO $$
BEGIN
  ALTER TABLE attendance_events ADD CONSTRAINT chk_attendance_deferred_other
    CHECK (progress_deferred_reason <> 'OTHER'
        OR (progress_deferred_remarks IS NOT NULL AND btrim(progress_deferred_remarks) <> ''));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_events_village
  ON attendance_events(survey_village_id) WHERE survey_village_id IS NOT NULL;

-- The query the daily report runs: who was out on this village on this day.
CREATE INDEX IF NOT EXISTS idx_attendance_events_employee_time
  ON attendance_events(employee_id, server_timestamp);
