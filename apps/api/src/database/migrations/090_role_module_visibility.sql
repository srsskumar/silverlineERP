-- 090: let an administrator decide which screens a role sees.
--
-- Every destination in the app shell is already gated on a permission --
-- nav.ts refuses to offer a link nobody holds the permission for. What an
-- organisation could not do was turn a link off for a role that *does* hold
-- the permission: a HR manager who should never open Procurement, a team
-- lead who should not see Payables, because the organisation runs that way
-- and not because of anything the permission system enforces.
--
-- No default rows: absence of a row means "defer to whether the role holds
-- the module's permission" -- computed at read time from role_permissions,
-- not stored here. An organisation that never opens this screen behaves
-- identically to today, and a role newly given a permission is immediately
-- visible without anybody having to remember to also flip a visibility row.
--
-- This is a UI convenience, never a security boundary: it decides what a
-- client renders, not what the API allows. Every route keeps its own
-- permission and scope checks exactly as they are -- see
-- MODULE_VISIBILITY_IS_NOT_A_PERMISSION in packages/shared/src/modules.ts
-- and the invariant test in apps/api/test that proves a hidden module's
-- routes still answer a direct call normally.

CREATE TABLE IF NOT EXISTS role_module_visibility (
  org_id      uuid NOT NULL REFERENCES organizations(id),
  role_code   varchar(100) NOT NULL REFERENCES roles(code),
  module_code varchar(64) NOT NULL,
  visible     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id),

  PRIMARY KEY (org_id, role_code, module_code)
);

CREATE INDEX IF NOT EXISTS idx_role_module_visibility_org
  ON role_module_visibility(org_id);
