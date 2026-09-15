-- Project categories, and GST on the contract value.
--
-- Two gaps the business raised after using the project screens.
--
-- A project already carries a *type* — how the work is contracted (AMC, goods,
-- services) — which drives the task workflow. What was missing is *what the
-- work is about*: drones, CCTV, survey equipment. The two are independent —
-- an AMC on CCTV and an AMC on drones share a workflow and nothing else — so
-- a second dimension is the honest model rather than multiplying the type list
-- into every combination.
--
-- The contract value was a single net figure. In practice the number on the
-- work order is quoted either inclusive or exclusive of GST, and which one it
-- is has to be recorded rather than assumed: booking an inclusive figure as
-- exclusive overstates every margin on the job by the tax rate.

CREATE TABLE IF NOT EXISTS project_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  code        VARCHAR(50) NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  CONSTRAINT chk_project_category_name CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_project_category_code ON project_categories(org_id, code);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS project_category_id UUID REFERENCES project_categories(id);

CREATE INDEX IF NOT EXISTS ix_projects_category ON projects(org_id, project_category_id);

-- ------------------------------------------------------ GST on the contract

ALTER TABLE projects
  -- Whether contract_value already includes GST. Null means nobody has said,
  -- which is deliberately distinct from "no" — an unanswered question should
  -- not silently become an answer that inflates the margin.
  ADD COLUMN IF NOT EXISTS contract_gst_included BOOLEAN,
  ADD COLUMN IF NOT EXISTS contract_gst_rate     NUMERIC(6,3);

DO $$
BEGIN
  ALTER TABLE projects
    ADD CONSTRAINT chk_projects_contract_gst_rate
    CHECK (contract_gst_rate IS NULL OR (contract_gst_rate >= 0 AND contract_gst_rate <= 28));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A rate without knowing which side of it the value sits on cannot be applied,
-- so the pair travels together.
DO $$
BEGIN
  ALTER TABLE projects
    ADD CONSTRAINT chk_projects_contract_gst_pair
    CHECK (contract_gst_rate IS NULL OR contract_gst_included IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
