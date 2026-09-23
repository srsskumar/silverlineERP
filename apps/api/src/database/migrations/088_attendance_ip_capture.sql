-- Capture the client's IP address and user agent on every punch (owner
-- request, 2026-09-23), the same way audit_events already does for logins
-- and every write that goes through mutate() (see common/domain.ts).
--
-- Attendance events had no such column at all: a punch could be replayed
-- from anywhere and nothing on the record said where it came from. This
-- adds the two columns; the API fills them at insert time from the request
-- that made the punch (apps/api/src/modules/attendance/routes.ts).
--
-- Additive only. Rows from before this migration keep NULLs -- there is no
-- IP to backfill for a punch that never recorded one.

ALTER TABLE attendance_events
  ADD COLUMN IF NOT EXISTS ip_address INET,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

COMMENT ON COLUMN attendance_events.ip_address IS
  'The client IP the punch request arrived from (req.ip; real client address behind the reverse proxy).';
COMMENT ON COLUMN attendance_events.user_agent IS
  'The User-Agent header sent with the punch request, for telling a browser session from the mobile app.';
