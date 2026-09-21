/*
 * §077 -- the audit trail refuses to be rewritten.
 *
 * audit_events was append-only by convention: 001 says so in a comment, and
 * no code path updates or deletes a row. A convention holds until the first
 * bug or the first injected statement, and an audit trail that can be
 * quietly edited is worth very little as evidence of anything -- the one
 * party able to edit it is precisely the one it is meant to record.
 *
 * So the table now refuses UPDATE and DELETE outright, row by row, whoever
 * asks. INSERT and SELECT are untouched.
 *
 * What this does not stop, deliberately:
 *   - TRUNCATE. Row triggers do not fire on it, and the test suites empty
 *     this table between files with it. Nothing in the application
 *     truncates anything.
 *   - The table's owner dropping or disabling the trigger. That takes DDL,
 *     which is loud and deliberate where a stray UPDATE is neither.
 *
 * The foreign keys into this table (organizations, users) are all NO
 * ACTION, so deleting a user or an organisation never cascades an UPDATE
 * or DELETE here; it is refused by the foreign key, as it was before.
 *
 * Safe on a live database: it adds a function and a trigger, changes no row,
 * and takes only a brief lock on the table to attach the trigger.
 */

CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING HINT = 'Record a correction as a new audit event instead.';
END
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
