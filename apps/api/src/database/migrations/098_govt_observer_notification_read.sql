-- GOVT_OBSERVER's ambient notification.read (round-2 post-deploy deep walk).
--
-- 071_village_ladder.sql created GOVT_OBSERVER holding only survey.dashboard.
-- Every other system role -- including narrowly-scoped ones like
-- CLIENT_VIEWER, PAYROLL_OFFICER and INVENTORY_MANAGER -- also holds
-- notification.read (packages/shared/src/s5.ts, S5_ROLE_GRANTS); GOVT_OBSERVER
-- was the one role left with nothing at all. The Inbox nav item is shown to
-- every signed-in user regardless of role, not gated per module, so a
-- government observer saw the tab and got a console 403 the moment they
-- opened it. Found live during the round-2 deep walk's govt crawl.
--
-- packages/shared was fixed in the same commit as this migration, but per
-- the same lesson as 097: a source change never reaches an already-seeded
-- deployment on its own, so the grant is applied here directly too. The
-- permissions-catalog insert is defensive, matching 097's precedent: the
-- code already exists on any database that has ever been seeded, but a
-- fresh, unseeded database applies migrations before the seed ever runs.

INSERT INTO permissions (code, description, module) VALUES
  ('notification.read', 'See your own notifications inbox', 'notifications')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'notification.read'
FROM roles r
WHERE r.code = 'GOVT_OBSERVER'
ON CONFLICT (role_id, permission_code) DO NOTHING;
