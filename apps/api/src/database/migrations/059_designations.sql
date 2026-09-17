-- Designations as a managed list (§note 8).
--
-- Designation was free text, so "Site Engineer", "Site engineer" and "Sr.
-- Site Engineer" are three job titles as far as any report is concerned.
--
-- It is deliberately NOT the RBAC role. A designation is what somebody is
-- called; a role is what they may do. The register holds Crane Operator,
-- Storekeeper, Electrician and Safety Officer — none of which has a natural
-- set of system permissions, and each would otherwise become a role with
-- none at all, which is an account that can sign in and do nothing.
--
-- The link between them is optional and one-way: a designation may name the
-- role its holders usually get, as a suggestion for whoever assigns access.
-- Creating a designation grants nobody anything. Privilege creation stays
-- behind admin.configure, off the form where employee data is keyed.

CREATE TABLE IF NOT EXISTS designations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  code          varchar(64) NOT NULL,
  label         varchar(160) NOT NULL,
  -- The role holders of this title usually need. Nullable, and nothing is
  -- granted automatically from it.
  role_id       uuid REFERENCES roles(id),
  display_order integer NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  UNIQUE (org_id, code)
);

CREATE INDEX IF NOT EXISTS idx_designations_org ON designations(org_id) WHERE active;

-- Seed from the titles already in use, so the dropdown opens with the
-- organisation's own vocabulary rather than an empty list somebody has to
-- fill in before they can add one employee.
--
-- Matched case-insensitively and trimmed, which is the whole reason for
-- having a list: "Site Engineer" and "site engineer " become one entry.
INSERT INTO designations (org_id, code, label, display_order)
SELECT DISTINCT ON (e.org_id, upper(btrim(e.designation)))
       e.org_id,
       upper(regexp_replace(btrim(e.designation), '[^A-Za-z0-9]+', '_', 'g')),
       btrim(e.designation),
       100
FROM employees e
WHERE e.designation IS NOT NULL AND btrim(e.designation) <> ''
ORDER BY e.org_id, upper(btrim(e.designation)), e.created_at
ON CONFLICT (org_id, code) DO NOTHING;

-- Point the employees at the list. The text column stays as it is: it is
-- what every existing report reads, and rewriting it would be a migration of
-- live data to gain nothing the join does not already give.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS designation_id uuid REFERENCES designations(id);

UPDATE employees e
   SET designation_id = d.id
  FROM designations d
 WHERE d.org_id = e.org_id
   AND upper(btrim(e.designation)) = upper(d.label)
   AND e.designation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_employees_designation ON employees(org_id, designation_id);
