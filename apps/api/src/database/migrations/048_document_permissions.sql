-- Document governance permissions (§46).
--
-- Separated from 047 because it is a different kind of change and was found
-- the hard way: 047 created the register, the application enforced
-- `document.manage`, and production had never heard of the permission — so
-- every write was refused with "insufficient permissions" and nothing in the
-- deployment said why.
--
-- New permissions previously arrived only through the seed script, which runs
-- against a fresh database and not against a deployment. A migration is the
-- thing that actually runs everywhere, so the grants belong here.
--
-- `document.read` and `document.upload` come from the employee document
-- feature — but from the seed script, not from a migration, and the seed runs
-- after migrations on a database that does not exist yet. So on a genuinely
-- empty database this migration used to fail on its own foreign key: it
-- granted `document.read` to ten roles before anything had defined it, and a
-- fresh build died here. Every deployment that worked had been seeded first
-- and never noticed.
--
-- Named here, idempotently, so a migration depends on migrations and nothing
-- else. Re-running against a database that already has them changes nothing,
-- and this file does not run again where it has already been applied.

INSERT INTO permissions (code, description, module) VALUES
  ('document.read',        'See the document register',                          'documents'),
  ('document.upload',      'Attach a document',                                  'documents'),
  ('document.manage',      'Add and amend documents on the register',            'documents'),
  ('document.confidential','See the detail of confidential documents',           'documents'),
  ('document.delete',      'Delete a document once retention permits',           'documents'),
  ('document.legalhold',   'Place and release a legal hold',                     'documents')
ON CONFLICT (code) DO NOTHING;

-- Grants, matching DOCUMENT_ROLE_GRANTS in packages/shared/src/documents.ts.
--
-- AUDITOR reads everything including confidential detail and can place a
-- hold, but cannot delete: an auditor who can destroy evidence is not a
-- control. Deletion is administrators only, and is in any case refused by
-- retention and by any legal hold.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.permission
FROM roles r
JOIN (VALUES
  ('SUPER_ADMIN','document.manage'),
  ('SUPER_ADMIN','document.confidential'),
  ('SUPER_ADMIN','document.delete'),
  ('SUPER_ADMIN','document.legalhold'),
  ('ADMIN','document.manage'),
  ('ADMIN','document.confidential'),
  ('ADMIN','document.delete'),
  ('ADMIN','document.legalhold'),
  ('HR_MANAGER','document.manage'),
  ('HR_MANAGER','document.confidential'),
  ('PROJECT_MANAGER','document.manage'),
  ('BID_TENDER_MANAGER','document.manage'),
  ('INVENTORY_MANAGER','document.manage'),
  ('PAYROLL_OFFICER','document.confidential'),
  ('AUDITOR','document.confidential'),
  ('AUDITOR','document.legalhold')
) AS g(role_code, permission) ON g.role_code = r.code
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- document.read for the roles the register is meant to be visible to. It
-- already exists as a permission, but a role that was never granted it for
-- employee documents still cannot open the register.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'document.read'
FROM roles r
WHERE r.code IN ('SUPER_ADMIN','ADMIN','HR_MANAGER','PROJECT_MANAGER',
                 'BID_TENDER_MANAGER','INVENTORY_MANAGER','PAYROLL_OFFICER',
                 'AUDITOR','TEAM_LEAD','SALES_BD_EXECUTIVE')
ON CONFLICT (role_id, permission_code) DO NOTHING;
