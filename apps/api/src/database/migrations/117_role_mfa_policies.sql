-- Whose roles need an authenticator is the organisation's decision -- and
-- only the organisation's (security review A-1, 2026-10-28).
--
-- The system roles are one shared row each (org_id IS NULL), and
-- PATCH /admin/roles/:id/mfa wrote an organisation's choice straight onto
-- that row. Excusing field roles for one contractor excused them for every
-- tenant on the deployment, and requiring an authenticator of a role locked
-- every other tenant's holders of it behind enrolment. Same shape as
-- role_scope_policies (065): the row keeps the seeded default, and an
-- organisation's own answer sits beside it, resolved with COALESCE wherever
-- the flag is read.

CREATE TABLE IF NOT EXISTS role_mfa_policies (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_code     varchar(100) NOT NULL REFERENCES roles(code),
  mfa_required  boolean NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,

  PRIMARY KEY (org_id, role_code),
  -- The floor the roles table already refuses (077): a super administrator
  -- can grant itself the permission to change this, so an organisation-level
  -- excuse would be the attack.
  CONSTRAINT chk_role_mfa_floor CHECK (NOT (role_code = 'SUPER_ADMIN' AND mfa_required = false))
);

CREATE INDEX IF NOT EXISTS idx_role_mfa_policies_org
  ON role_mfa_policies(org_id);
