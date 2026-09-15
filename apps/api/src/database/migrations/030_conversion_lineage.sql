-- Record lineage and the conversion ledger (§37.1, §37.2).
--
-- §37.1: "Conversion must never copy data without retaining provenance."
-- Rather than scatter nullable source_id columns across every destination
-- table, one ledger records every hop in the chain. The destination tables keep
-- the direct FK they need for joins (projects.tender_id), and this table keeps
-- the actor, the timestamp and exactly which fields were carried over — which
-- is what §37.2 requires the audit event to contain.

CREATE TABLE IF NOT EXISTS record_conversions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  source_type     VARCHAR(40) NOT NULL,
  source_id       UUID NOT NULL,
  target_type     VARCHAR(40) NOT NULL,
  target_id       UUID NOT NULL,
  carried_fields  JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id        UUID REFERENCES users(id),
  reason          TEXT,
  -- §37.2 rollback is a controlled workflow, never a hard delete.
  reverted_at     TIMESTAMPTZ,
  reverted_by     UUID REFERENCES users(id),
  reverted_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_conversion_source CHECK (source_type IN
    ('LEAD','OPPORTUNITY','TENDER','PRIVATE_PROPOSAL','PROJECT','PURCHASE_ORDER','GRN')),
  CONSTRAINT chk_conversion_target CHECK (target_type IN
    ('OPPORTUNITY','TENDER','PRIVATE_PROPOSAL','PROJECT','VENDOR_INVOICE','PAYMENT')),
  CONSTRAINT chk_conversion_revert_complete CHECK (
    (reverted_at IS NULL AND reverted_by IS NULL AND reverted_reason IS NULL)
    OR (reverted_at IS NOT NULL AND reverted_by IS NOT NULL AND reverted_reason IS NOT NULL)
  )
);

-- §37.2 "Conversion is idempotent; retries cannot create duplicate Projects,
-- POs, invoices, or financial effects."
--
-- This partial unique index is the enforcement, not merely a lookup aid: a
-- second attempt to convert the same source into the same kind of destination
-- raises a constraint violation inside the transaction, so the retry cannot
-- commit a second project. Reverted rows are excluded so an authorised
-- rollback-and-redo remains possible.
CREATE UNIQUE INDEX IF NOT EXISTS uk_conversion_source_target
  ON record_conversions(source_type, source_id, target_type)
  WHERE reverted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_conversion_target ON record_conversions(target_type, target_id);
CREATE INDEX IF NOT EXISTS ix_conversion_org ON record_conversions(org_id, created_at DESC);

-- §8.7 / §6.2: the tender stays permanently linked to the resulting project.
-- project_kind mirrors the tender/proposal track the work came from, and is
-- named to avoid colliding with the existing project_type_id (workflow config).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS tender_id    UUID REFERENCES tenders(id),
  ADD COLUMN IF NOT EXISTS proposal_id  UUID REFERENCES private_proposals(id),
  ADD COLUMN IF NOT EXISTS client_id    UUID REFERENCES clients(id),
  ADD COLUMN IF NOT EXISTS project_kind VARCHAR(20),
  ADD COLUMN IF NOT EXISTS contract_value   NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS work_order_number VARCHAR(100);

-- ADD CONSTRAINT has no IF NOT EXISTS; guard it so re-running this file is
-- harmless (migrate.ts runs it once, but a manual replay should not error).
DO $$
BEGIN
  ALTER TABLE projects
    ADD CONSTRAINT chk_projects_kind
    CHECK (project_kind IS NULL OR project_kind IN ('GOVERNMENT','PRIVATE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One project per tender: the link is 1:1 in §8.7, and without this a repeated
-- conversion that bypassed the ledger could still fan out.
CREATE UNIQUE INDEX IF NOT EXISTS uk_projects_tender
  ON projects(tender_id) WHERE tender_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_projects_proposal
  ON projects(proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_projects_client ON projects(org_id, client_id);

-- §6.2 task costing and subcontracting.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS budgeted_cost      NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS actual_cost        NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS assigned_vendor_id UUID REFERENCES vendors(id);

CREATE INDEX IF NOT EXISTS ix_tasks_vendor
  ON tasks(assigned_vendor_id) WHERE assigned_vendor_id IS NOT NULL;
