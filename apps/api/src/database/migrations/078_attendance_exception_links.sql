/*
 * §078 -- an approved attendance exception has to change attendance.
 *
 * Until now an exception row said only "this employee, this reason". A
 * punch that went to review (outside the fence, poor accuracy, a mock
 * location, a replayed offline punch with a skewed clock) created the event
 * and the exception but no attendance record, and nothing tied the two
 * together. Approving it changed the exception's status and nothing else,
 * so the day stayed absent and payroll docked it as loss of pay.
 *
 * So the exception now carries what approval must apply:
 *
 *   attendance_event_id  the punch that was held back for review;
 *   work_date            the day a regularization is about;
 *   claimed_check_in /   the times a regularization claims, which used to
 *   claimed_check_out    ride along as text inside `reason`.
 *
 * All four are nullable and additive: exceptions raised by hand have no
 * event, and every row written before this migration has none of them.
 */

ALTER TABLE attendance_exceptions
  ADD COLUMN IF NOT EXISTS attendance_event_id UUID
    REFERENCES attendance_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS work_date DATE,
  ADD COLUMN IF NOT EXISTS claimed_check_in TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_check_out TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_attendance_exceptions_event
  ON attendance_exceptions(attendance_event_id)
  WHERE attendance_event_id IS NOT NULL;

/*
 * Link the system exceptions already on file to the punch that raised them.
 *
 * The punch route stores the event and raises the exception in one
 * transaction, and both rows take created_at from NOW(), which is the
 * transaction's start time. One punch per transaction, so equal created_at
 * for the same employee identifies the pair exactly -- no guessing by
 * proximity. A pending exception linked here becomes applicable on approval
 * like a new one; nothing already decided is re-applied.
 */
UPDATE attendance_exceptions x
   SET attendance_event_id = ev.id
  FROM attendance_events ev
 WHERE x.source = 'SYSTEM'
   AND x.attendance_event_id IS NULL
   AND ev.employee_id = x.employee_id
   AND ev.created_at = x.created_at;

/*
 * Recover the work date of regularizations filed before the column existed.
 *
 * The route appended "[work_date: YYYY-MM-DD ...]" to the reason, always at
 * the very end, and only after validating it as a real calendar date. The
 * pattern is anchored to that suffix so a date typed into the person's own
 * words is never mistaken for it. The claimed times are not recovered: they
 * were stored as whatever ISO form the client sent, and a cast that failed
 * would stop this migration on a live database.
 */
UPDATE attendance_exceptions
   SET work_date = substring(reason FROM '\[work_date: (\d{4}-\d{2}-\d{2})[^\[\]]*\]$')::date
 WHERE exception_type = 'REGULARIZATION'
   AND work_date IS NULL
   AND reason ~ '\[work_date: \d{4}-\d{2}-\d{2}[^\[\]]*\]$';

/*
 * A holiday can now be withdrawn (active = false) rather than deleted, so
 * uniqueness only binds the live rows. Otherwise withdrawing a wrongly
 * dated holiday would block entering the right one on that date and scope
 * forever. Every existing row already satisfies the stricter index, so the
 * narrower one is always buildable.
 */
DROP INDEX IF EXISTS uk_holidays_org_date_scope;
CREATE UNIQUE INDEX IF NOT EXISTS uk_holidays_org_date_scope ON holidays (
  org_id,
  date,
  COALESCE(scope_type, ''),
  COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE active;
