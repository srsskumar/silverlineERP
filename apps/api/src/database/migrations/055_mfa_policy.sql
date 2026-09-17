-- Deciding who needs two-factor authentication, instead of hardcoding it.
--
-- The requirement was a list of role codes compiled into the API:
-- SUPER_ADMIN, ADMIN, PROJECT_MANAGER, TEAM_LEAD, AUDITOR. That is a policy
-- decision sitting in a place only a deploy can change, and it was wrong for
-- the field: a rover operator reading a six-digit code off a second device
-- before every shift pays that cost every morning, and whether it is worth
-- paying is the organisation's call, not the code's.
--
-- Two levers, because the question is asked at two levels. A role carries the
-- default -- "team leads need it, surveyors do not". An account overrides it
-- -- "this particular person handles payroll", "this particular phone cannot
-- run an authenticator". Neither of those is a property of a role.

ALTER TABLE roles
  -- Whether this role's holders must enrol an authenticator.
  ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;

-- Exactly the five roles the API had compiled in, so nothing changes on the
-- day this ships. What changes is that they can now be changed.
UPDATE roles SET mfa_required = true
WHERE code IN ('SUPER_ADMIN', 'ADMIN', 'PROJECT_MANAGER', 'TEAM_LEAD', 'AUDITOR');

ALTER TABLE users
  -- INHERIT follows the roles. REQUIRED and EXEMPT override them.
  --
  -- Not a boolean: "no override" and "deliberately exempt" are different
  -- facts, and collapsing them would silently re-require somebody the moment
  -- their role's default changed.
  ADD COLUMN IF NOT EXISTS mfa_policy varchar(16) NOT NULL DEFAULT 'INHERIT';

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_mfa_policy
    CHECK (mfa_policy IN ('INHERIT', 'REQUIRED', 'EXEMPT'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The floor, enforced here as well as in the API.
--
-- A super administrator can grant itself any permission in the system,
-- including the permission to change this setting. If that account can be
-- reduced to a password then every other control below it is decorative, so
-- the opting out would itself be the attack. The API refuses it; the table
-- refuses it too, because a policy that only holds while the application
-- layer is the only writer is not a policy.
DO $$
BEGIN
  ALTER TABLE roles ADD CONSTRAINT chk_roles_mfa_floor
    CHECK (code <> 'SUPER_ADMIN' OR mfa_required);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
