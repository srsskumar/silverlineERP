-- Record which *version* of a fence decided a punch (§9.1, §18 reconstruction).
--
-- geofence_id alone is not enough evidence: a fence's tolerance and accuracy
-- threshold can be edited afterwards (each edit bumps its version), so an
-- auditor replaying an old punch against today's fence can reach a different
-- INSIDE/OUTSIDE answer than the server did at the time. Pinning the version
-- makes the original decision reproducible.
ALTER TABLE attendance_events
  ADD COLUMN IF NOT EXISTS geofence_version INTEGER;
