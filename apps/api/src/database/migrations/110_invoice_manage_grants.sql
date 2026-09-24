-- Narrow invoice.create permission (fix round 1, I4, controller ruling).
--
-- This migration originally gave INVENTORY_MANAGER the broad invoice.manage
-- permission so POST /api/v1/invoices moving off inventory.manage would not
-- take away its ability to create a vendor invoice. It never reached a live
-- database (unreleased), and invoice.manage was too broad a replacement
-- anyway: it also covers editing an invoice's lines, changing its status,
-- disputing it and recording a three-way match against it, none of which
-- INVENTORY_MANAGER needs. Rewritten here in place rather than superseded.
--
-- POST /api/v1/invoices now accepts invoice.create OR invoice.manage
-- (apps/api/src/modules/inventory/routes.ts's guard, built from
-- apps/api/src/common/auth.ts's requireAnyPermission); every other
-- vendor-invoice write stays invoice.manage only. Every role that already
-- holds invoice.manage is granted invoice.create too -- invoice.manage
-- already implies it, so nothing changes for them, but the create route's
-- OR-gate is then visible directly in role_permissions rather than only in
-- the route's code. INVENTORY_MANAGER, which holds neither today, is
-- granted invoice.create alone.
--
-- Idempotent throughout: ON CONFLICT DO NOTHING against permissions' own
-- primary key (code) and role_permissions' own primary key
-- (role_id, permission_code).
INSERT INTO permissions (code, description, module) VALUES
  ('invoice.create', 'Create a vendor invoice', 'finance')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT rp.role_id, 'invoice.create'
  FROM role_permissions rp
 WHERE rp.permission_code = 'invoice.manage'
ON CONFLICT (role_id, permission_code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'invoice.create'
  FROM roles r
 WHERE r.code = 'INVENTORY_MANAGER'
ON CONFLICT (role_id, permission_code) DO NOTHING;
