-- Grant holiday.read to staff roles (owner decision 2026-10-01 #1).
--
-- PROJECT_MANAGER, TEAM_LEAD and EMPLOYEE hold leave.request but not
-- holiday.read, so they cannot see the calendar their own leave request is
-- checked against (MA-015). SALES_BD_EXECUTIVE, BID_TENDER_MANAGER,
-- INVENTORY_MANAGER, PAYROLL_OFFICER and AUDITOR do not hold leave.request
-- in this codebase, but the holiday calendar is read-only and
-- non-confidential, and the owner approved treating them as staff for this
-- one permission (docs/qa/2026-09-24/owner-policy-batch.md item 6).
--
-- packages/shared/src/s1.ts (S1_ROLE_GRANTS) is fixed in the same commit,
-- but per 097/098/100/112's own precedent a source change never reaches an
-- already-seeded deployment on its own, so the grant is applied here too.
-- The permissions-catalog insert is defensive: holiday.read already exists
-- on any database that has ever been seeded.

INSERT INTO permissions (code, description, module) VALUES
  ('holiday.read', 'See the organisation holiday calendar', 'holidays')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'holiday.read'
FROM roles r
WHERE r.code IN ('PROJECT_MANAGER', 'TEAM_LEAD', 'EMPLOYEE',
                  'SALES_BD_EXECUTIVE', 'BID_TENDER_MANAGER', 'INVENTORY_MANAGER',
                  'PAYROLL_OFFICER', 'AUDITOR')
  AND r.org_id IS NULL
ON CONFLICT (role_id, permission_code) DO NOTHING;
