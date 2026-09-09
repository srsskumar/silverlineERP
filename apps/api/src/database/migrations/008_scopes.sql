-- Silverline ERP RBAC scopes (PRD §4.1): nullable scope on user_roles.
-- A NULL scope_type (or NULL scope_id) means a GLOBAL assignment: the user
-- sees everything their permissions allow. A set scope restricts the two
-- scope-filtered reads (GET /employees, GET /tasks); every other endpoint
-- stays permission-gated only (see apps/api README "RBAC" section).
-- Idempotent: every statement is IF NOT EXISTS / IF EXISTS-safe.

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS scope_type VARCHAR(50);
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS scope_id UUID;

-- The S0 primary key (user_id, role_id) cannot hold scoped duplicates, so it
-- is replaced with a scope-aware unique index (NULL scope collapses to a
-- single global row per user+role, mirroring the holidays scope index).
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS uk_user_roles_scope ON user_roles (
  user_id,
  role_id,
  COALESCE(scope_type, ''),
  COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
