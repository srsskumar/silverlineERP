-- Grants INVENTORY_MANAGER the invoice.manage permission (owner decision
-- 2026-09-24).
--
-- POST /api/v1/invoices moved from gating on inventory.manage to
-- invoice.manage, matching every other vendor-invoice write (PATCH
-- .../lines, .../status, .../dispute, .../match). INVENTORY_MANAGER held
-- inventory.manage but not invoice.manage, so without this it would lose
-- the ability to create a vendor invoice it already had. seed.ts carries
-- the same grant for a fresh install; this backfills an existing one.
--
-- Idempotent: ON CONFLICT DO NOTHING against role_permissions' own primary
-- key (role_id, permission_code).
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'invoice.manage'
  FROM roles r
 WHERE r.code = 'INVENTORY_MANAGER'
ON CONFLICT DO NOTHING;
