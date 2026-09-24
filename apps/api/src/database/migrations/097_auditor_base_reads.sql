-- AUDITOR's base reads behind its *_read_all grants (P-002 follow-up).
--
-- 167ffea (P-002) fixed EXPENSE_ROLE_GRANTS and S1_ROLE_GRANTS in
-- packages/shared so AUDITOR pairs `expense.read` with `expense.read_all`
-- and `org.units.read` with `employee.read` -- every GET /expense-claims*
-- route and the /employees district filter gate on the base permission
-- first and only widen scope with the *_all/companion grant internally, so
-- without the base code an auditor 403s outright.
--
-- That code change alone never reaches an already-seeded deployment: the
-- seed script only writes role_permissions once, at bootstrap, and a
-- redeploy that ships new source does not re-run it against a live
-- database. This migration is the thing that actually runs everywhere,
-- applying the same two grants directly.
--
-- The permissions-catalog inserts are defensive, matching 048's precedent:
-- both codes should already exist on any database that has ever been
-- seeded (seed.ts's permission-catalog loop includes EXPENSE_PERMISSIONS
-- and S1_ALL_PERMISSIONS), but a fresh, unseeded database applies
-- migrations in order before the seed ever runs, and role_permissions has
-- a foreign key to permissions.code.

INSERT INTO permissions (code, description, module) VALUES
  ('expense.read',   'See expense claims (own/assigned, or org-wide with expense.read_all)', 'expenses'),
  ('org.units.read',  'See the org unit tree (district/division/mandal/village/site)', 'org')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.permission
FROM roles r
JOIN (VALUES
  ('AUDITOR', 'expense.read'),
  ('AUDITOR', 'org.units.read')
) AS g(role_code, permission) ON g.role_code = r.code
ON CONFLICT (role_id, permission_code) DO NOTHING;
