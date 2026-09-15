-- Permissions and system roles for the commercial spine (§4, §4.2).
--
-- Convention note: despite roles.org_id existing, system roles in this schema
-- are GLOBAL — seed.ts inserts them with org_id NULL, and roles_code_key makes
-- `code` unique across the whole table. An earlier draft of this migration
-- cross-joined organizations to create one role row per org; with 50 orgs that
-- inserts 50 rows sharing a code and dies on roles_code_key. Match the seed.
--
-- The canonical grant map lives in packages/shared/src/crm.ts, because seed.ts
-- rebuilds role_permissions from those maps on every run and would drop any
-- grant that existed only here. This migration exists so a deployment that does
-- not re-run the seeder still converges.

INSERT INTO permissions (code, description, module) VALUES
  ('client.read',     'View client and contact master',                 'crm'),
  ('client.manage',   'Create and update clients and contacts',         'crm'),
  ('lead.read',       'View leads and pipeline',                        'crm'),
  ('lead.manage',     'Create and update leads, opportunities, activity','crm'),
  ('lead.convert',    'Convert a qualified opportunity into a tender or proposal', 'crm'),
  ('tender.read',     'View tenders, bids and instruments',             'tender'),
  ('tender.manage',   'Create and update tenders, corrigenda, checklist','tender'),
  ('tender.submit',   'Move a tender to Submitted',                     'tender'),
  ('tender.award',    'Record award or rejection of a tender',          'tender'),
  ('tender.override', 'Override an incomplete eligibility checklist with a reason', 'tender'),
  ('tender.convert',  'Convert an awarded tender into a project',       'tender'),
  ('instrument.read',   'View EMD and bank guarantee instruments',      'tender'),
  ('instrument.manage', 'Record and release EMD/BG instruments',        'tender')
ON CONFLICT (code) DO NOTHING;

-- §4: Sales/BD Executive and Bid/Tender Manager, global like every other
-- system role. Procurement Officer and Finance User arrive with their modules.
INSERT INTO roles (org_id, code, name, is_system_role, description) VALUES
  (NULL, 'SALES_BD_EXECUTIVE', 'Sales / BD Executive', TRUE,
   'Lead capture, qualification and opportunity tracking through tender identification'),
  (NULL, 'BID_TENDER_MANAGER', 'Bid / Tender Manager', TRUE,
   'Tender identification, eligibility, bid pricing, submission and EMD/BG tracking')
ON CONFLICT (code) DO NOTHING;

-- Grants, mirroring CRM_ROLE_GRANTS in packages/shared/src/crm.ts.
-- Keep the two in step: seed.ts rebuilds from the TypeScript map.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.code
FROM roles r
JOIN (VALUES
  -- Super Admin holds everything, including the override.
  ('SUPER_ADMIN','client.read'),('SUPER_ADMIN','client.manage'),
  ('SUPER_ADMIN','lead.read'),('SUPER_ADMIN','lead.manage'),('SUPER_ADMIN','lead.convert'),
  ('SUPER_ADMIN','tender.read'),('SUPER_ADMIN','tender.manage'),('SUPER_ADMIN','tender.submit'),
  ('SUPER_ADMIN','tender.award'),('SUPER_ADMIN','tender.override'),('SUPER_ADMIN','tender.convert'),
  ('SUPER_ADMIN','instrument.read'),('SUPER_ADMIN','instrument.manage'),

  -- Admin runs the pipeline but not the override (§4.1 reserves it).
  ('ADMIN','client.read'),('ADMIN','client.manage'),
  ('ADMIN','lead.read'),('ADMIN','lead.manage'),('ADMIN','lead.convert'),
  ('ADMIN','tender.read'),('ADMIN','tender.manage'),('ADMIN','tender.submit'),
  ('ADMIN','tender.award'),('ADMIN','tender.convert'),
  ('ADMIN','instrument.read'),('ADMIN','instrument.manage'),

  -- §4: no approval authority, so no submit/award/override.
  ('SALES_BD_EXECUTIVE','client.read'),('SALES_BD_EXECUTIVE','client.manage'),
  ('SALES_BD_EXECUTIVE','lead.read'),('SALES_BD_EXECUTIVE','lead.manage'),
  ('SALES_BD_EXECUTIVE','lead.convert'),('SALES_BD_EXECUTIVE','tender.read'),

  -- Owns the tender, including submission and instruments. Deliberately
  -- without tender.override: the checklist gates this role's own work.
  ('BID_TENDER_MANAGER','client.read'),('BID_TENDER_MANAGER','lead.read'),
  ('BID_TENDER_MANAGER','tender.read'),('BID_TENDER_MANAGER','tender.manage'),
  ('BID_TENDER_MANAGER','tender.submit'),('BID_TENDER_MANAGER','tender.award'),
  ('BID_TENDER_MANAGER','tender.convert'),
  ('BID_TENDER_MANAGER','instrument.read'),('BID_TENDER_MANAGER','instrument.manage'),

  -- §4: reads across all domains, never mutates.
  ('AUDITOR','client.read'),('AUDITOR','lead.read'),
  ('AUDITOR','tender.read'),('AUDITOR','instrument.read'),

  -- Commercial context for their projects; does not run the pipeline.
  ('PROJECT_MANAGER','client.read'),('PROJECT_MANAGER','tender.read'),
  ('PROJECT_MANAGER','instrument.read'),

  ('INVENTORY_MANAGER','client.read')
) AS g(role_code, code) ON g.role_code = r.code
ON CONFLICT DO NOTHING;
