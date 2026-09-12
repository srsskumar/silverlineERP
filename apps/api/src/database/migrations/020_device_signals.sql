-- Anti-fraud device signals on attendance events (requirements §9.3).
--
-- Attendance previously recorded only the OS `mock_location` flag, which
-- catches a naive mock provider and nothing else. The Android client now also
-- reports emulator/device fingerprints and the movement implied since its last
-- punch; the server re-derives impossible travel from its own event history
-- (the client's copy is advisory and forgeable) and stores both.
--
-- jsonb rather than columns: the signal set will grow as platforms expose more,
-- and none of it is queried in a hot path — it exists for review and audit.

ALTER TABLE attendance_events
  ADD COLUMN IF NOT EXISTS device_signals JSONB;

COMMENT ON COLUMN attendance_events.device_signals IS
  'Advisory anti-fraud signals: client-reported device fingerprint plus the server-derived movement anomaly. Never authoritative on its own.';

-- Reviewers filter to flagged punches; the partial index keeps that cheap
-- without indexing the overwhelming majority of clean events.
CREATE INDEX IF NOT EXISTS idx_attendance_events_flagged
  ON attendance_events(employee_id, server_timestamp DESC)
  WHERE device_signals IS NOT NULL;

-- Impossible-travel detection reads the employee's previous positioned event.
CREATE INDEX IF NOT EXISTS idx_attendance_events_employee_time
  ON attendance_events(employee_id, client_timestamp DESC)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;
