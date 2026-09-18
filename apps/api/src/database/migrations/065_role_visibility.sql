-- Who sees the whole organisation, and who sees their own work (§note 17).
--
-- The machinery to restrict somebody to their own projects and tasks has
-- always been there — user_roles carries a scope, and every list honours it.
-- What was missing was a default. A role row with no scope means global, so
-- five of eight employees, three of five team leads and two of five project
-- managers could read every project and task in the organisation. Nobody
-- chose that; it is what happens when the safe setting is the one you have to
-- remember to set.
--
-- One hardcoded exception existed — EMPLOYEE was forced to self-scope in
-- code, whatever the row said — which is the right behaviour arrived at the
-- wrong way: invisible, unconfigurable, and silently different from every
-- other role.
--
-- Per organisation, because the answer differs. A contractor running one
-- district wants its project managers to see everything; one running six
-- does not.

CREATE TABLE IF NOT EXISTS role_scope_policies (
  org_id        uuid NOT NULL REFERENCES organizations(id),
  role_code     varchar(100) NOT NULL REFERENCES roles(code),

  /*
   * ASSIGNED: only what is theirs — tasks assigned to them, projects they are
   * on, and anything their own scope rows already allow.
   * GLOBAL: the whole organisation, subject to the permissions they hold.
   */
  default_scope varchar(16) NOT NULL DEFAULT 'GLOBAL',

  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id),

  PRIMARY KEY (org_id, role_code),
  CONSTRAINT chk_role_scope_default CHECK (default_scope IN ('GLOBAL', 'ASSIGNED'))
);

/*
 * The starting position: the three roles that do the work see their own work.
 *
 * EMPLOYEE was already behaving this way through the hardcoded rule, so for
 * them this changes nothing and only makes it visible. TEAM_LEAD and
 * PROJECT_MANAGER are a real change, and a deliberate one — either can be set
 * back to GLOBAL from Administration without a deployment.
 */
INSERT INTO role_scope_policies (org_id, role_code, default_scope)
SELECT o.id, r.code, 'ASSIGNED'
  FROM organizations o
  CROSS JOIN roles r
 WHERE r.code IN ('EMPLOYEE', 'TEAM_LEAD', 'PROJECT_MANAGER')
ON CONFLICT (org_id, role_code) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_role_scope_policies_org
  ON role_scope_policies(org_id);
