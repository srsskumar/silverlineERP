-- SALES_BD_EXECUTIVE and BID_TENDER_MANAGER's ambient notification.read
-- (Task 5f, round-2 GAPs).
--
-- Every system role holds notification.read (packages/shared/src/s5.ts,
-- S5_ROLE_GRANTS) except these two, whose S5 grants were left empty when S5
-- shipped -- both roles are created by 031_commercial_permissions.sql, well
-- before S5 existed, and were never revisited. The Inbox nav item is shown
-- to every signed-in user regardless of role, not gated per module (see
-- lib/nav.ts's own comment on this), so a Sales/BD Executive or a Bid/Tender
-- Manager sees the tab and gets a console 403 the instant they open it --
-- the same bug shape as GOVT_OBSERVER's (098_govt_observer_notification_read.sql,
-- fd4a046), on the two roles that fix's own commit message flagged as likely
-- having the identical gap but left unchanged pending confirmation.
--
-- packages/shared is fixed in the same commit as this migration, but per
-- 097/098's precedent a source change never reaches an already-seeded
-- deployment on its own, so the grant is applied here directly too. The
-- permissions-catalog insert is defensive: the code already exists on any
-- database that has ever been seeded, but a fresh, unseeded database applies
-- migrations before the seed ever runs.

INSERT INTO permissions (code, description, module) VALUES
  ('notification.read', 'See your own notifications inbox', 'notifications')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'notification.read'
FROM roles r
WHERE r.code IN ('SALES_BD_EXECUTIVE', 'BID_TENDER_MANAGER')
ON CONFLICT (role_id, permission_code) DO NOTHING;
