-- Silverline ERP has no geo-fencing (owner decision, 2026-09-22).
--
-- The fence permissions go: nothing is gated on them any more, and a grant
-- that opens no door is a lie in the roles screen. role_permissions references
-- permissions(code), so the grants are removed before the codes.
--
-- Deliberately NOT dropped: geo_fences, geo_fence_employee_assignments, and
-- the fence columns on attendance_events (geofence_result, geofence_id,
-- geofence_version) and attendance_records (geofence_violation). Punches and
-- exceptions raised while fencing was on still refer to them, and that
-- history must stay readable. Nothing writes them from this migration on;
-- geofence_result keeps its default of 'NO_FENCE' for new rows.
--
-- Pending OUTSIDE_GEOFENCE / NO_LOCATION exceptions are left as they are:
-- they remain decidable, and approving one still puts its punch onto the
-- day. No new exception of that kind is raised.

DELETE FROM role_permissions
 WHERE permission_code IN ('geo.read', 'geo.manage');

DELETE FROM permissions
 WHERE code IN ('geo.read', 'geo.manage');
