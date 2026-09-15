-- Expense management and project cost control (§6.8, §15.6, §16).
--
-- Two modules land together because neither is useful alone: §16.4 requires an
-- approved billable expense to reach the project's actual cost, and until this
-- migration there was nowhere for it to land.
--
-- The cost ledger is append-only. Four writers post to it — expense claims,
-- purchase orders, goods receipts and RA bills — and a shared mutable total
-- between four writers is a reconciliation meeting waiting to happen. A
-- correction is a reversing entry, never an UPDATE, so the ledger can always
-- explain how it reached its number.

-- ------------------------------------------------------------- cost heads

CREATE TABLE IF NOT EXISTS cost_heads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  code        VARCHAR(30) NOT NULL,
  name        VARCHAR(120) NOT NULL,
  kind        VARCHAR(20) NOT NULL,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  CONSTRAINT chk_cost_head_kind CHECK (kind IN ('LABOUR','MATERIAL','SUBCONTRACT','EQUIPMENT','OVERHEAD','OTHER'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_cost_head_code ON cost_heads(org_id, code);

-- --------------------------------------------------------- project budget

CREATE TABLE IF NOT EXISTS project_budgets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_head_id    UUID NOT NULL REFERENCES cost_heads(id),
  budgeted_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- Budgets are revised, and last year's number is evidence. A revision
  -- supersedes rather than overwrites.
  revision        INTEGER NOT NULL DEFAULT 1,
  superseded_at   TIMESTAMPTZ,
  revision_reason TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID,
  CONSTRAINT chk_budget_amount CHECK (budgeted_amount >= 0)
);

-- One live row per project and head; superseded revisions stay for the audit.
CREATE UNIQUE INDEX IF NOT EXISTS uk_project_budget_live
  ON project_budgets(project_id, cost_head_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_project_budget_project ON project_budgets(org_id, project_id);

-- ---------------------------------------------------------- cost ledger

CREATE TABLE IF NOT EXISTS project_cost_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_head_id UUID NOT NULL REFERENCES cost_heads(id),
  -- COMMITTED is money promised (an open purchase order); ACTUAL is money
  -- incurred. A receipt posts an actual and reverses the commitment, so the
  -- pair nets correctly and the forecast never double-counts.
  nature       VARCHAR(12) NOT NULL,
  source_type  VARCHAR(20) NOT NULL,
  source_id    UUID,
  entry_date   DATE NOT NULL,
  amount       NUMERIC(18,2) NOT NULL,
  narration    TEXT,
  reversal_of  UUID REFERENCES project_cost_entries(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID,
  CONSTRAINT chk_cost_nature CHECK (nature IN ('COMMITTED','ACTUAL')),
  CONSTRAINT chk_cost_source CHECK (source_type IN
    ('EXPENSE_CLAIM','PURCHASE_ORDER','GOODS_RECEIPT','RA_BILL','PAYROLL','MANUAL')),
  -- A manual entry is the only way into this ledger with no document behind
  -- it, so it must at least say why it exists.
  CONSTRAINT chk_cost_manual_narration CHECK (source_type <> 'MANUAL' OR narration IS NOT NULL),
  CONSTRAINT chk_cost_reversal_sign CHECK (reversal_of IS NULL OR amount <> 0)
);

CREATE INDEX IF NOT EXISTS ix_cost_entry_project ON project_cost_entries(org_id, project_id, cost_head_id);
CREATE INDEX IF NOT EXISTS ix_cost_entry_source ON project_cost_entries(source_type, source_id);
-- A document posts to the ledger once. Without this a retried approval books
-- the same claim twice and the project silently carries double the cost.
CREATE UNIQUE INDEX IF NOT EXISTS uk_cost_entry_source
  ON project_cost_entries(source_type, source_id, cost_head_id, nature)
  WHERE source_id IS NOT NULL AND reversal_of IS NULL;

-- ------------------------------------------------------- expense policies

CREATE TABLE IF NOT EXISTS expense_policies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organizations(id),
  category               VARCHAR(30) NOT NULL,
  effective_from         DATE NOT NULL,
  -- Null while this is the standing policy for the category.
  effective_to           DATE,
  per_line_limit         NUMERIC(18,2),
  per_claim_limit        NUMERIC(18,2),
  -- The per-diem rate. A per-diem is an entitlement of units x rate, not a
  -- capped reimbursement, so a limit alone cannot value the claim.
  unit_rate              NUMERIC(18,2),
  requires_receipt_above NUMERIC(18,2),
  applies_to_grade       VARCHAR(50),
  notes                  TEXT,
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             UUID,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             UUID,
  CONSTRAINT chk_exp_policy_category CHECK (category IN
    ('TRAVEL','LODGING','FUEL','PER_DIEM','SITE_MATERIALS_PETTY',
     'CLIENT_ENTERTAINMENT','COMMUNICATION','OTHER')),
  CONSTRAINT chk_exp_policy_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_exp_policy_perdiem CHECK (category <> 'PER_DIEM' OR unit_rate IS NOT NULL)
);

-- Two standing policies for one category and grade would make the effective
-- policy a matter of luck.
CREATE UNIQUE INDEX IF NOT EXISTS uk_exp_policy_open
  ON expense_policies(org_id, category, COALESCE(applies_to_grade, ''))
  WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS ix_exp_policy_lookup ON expense_policies(org_id, category, effective_from);

-- --------------------------------------------------------- expense claims

CREATE TABLE IF NOT EXISTS expense_claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  claim_no          VARCHAR(50) NOT NULL,
  -- Whose expense it is. Held separately from requested_by because a site
  -- clerk keys in a manager's claim, and maker-checker has to exclude both.
  employee_id       UUID REFERENCES employees(id),
  claimant_user_id  UUID REFERENCES users(id),
  requested_by      UUID NOT NULL REFERENCES users(id),
  project_id        UUID REFERENCES projects(id),
  cost_head_id      UUID REFERENCES cost_heads(id),
  claim_date        DATE NOT NULL,
  purpose           TEXT NOT NULL,
  total_claimed     NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- What policy allows without an override, evaluated at submission.
  total_allowed     NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_excess      NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- The amount actually authorised, which is total_allowed unless somebody
  -- with expense.override signed for the excess.
  approved_amount   NUMERIC(18,2),
  status            VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  approval_id       UUID REFERENCES approval_instances(id),
  policy_exception  BOOLEAN NOT NULL DEFAULT false,
  override_reason   TEXT,
  override_by       UUID REFERENCES users(id),
  rejection_reason  TEXT,
  withdrawn_reason  TEXT,
  submitted_at      TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  CONSTRAINT chk_exp_claim_status CHECK (status IN
    ('DRAFT','SUBMITTED','APPROVED','REJECTED','WITHDRAWN','REIMBURSED')),
  CONSTRAINT chk_exp_claim_purpose CHECK (length(trim(purpose)) > 0),
  CONSTRAINT chk_exp_claim_rejection CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CONSTRAINT chk_exp_claim_withdrawn CHECK (status <> 'WITHDRAWN' OR withdrawn_reason IS NOT NULL),
  -- The policy-exception report (§16.5) is only possible if the reason was
  -- captured at the moment of override rather than reconstructed later.
  CONSTRAINT chk_exp_claim_override CHECK (override_reason IS NULL OR override_by IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_exp_claim_no ON expense_claims(org_id, claim_no);
CREATE INDEX IF NOT EXISTS ix_exp_claim_status ON expense_claims(org_id, status);
CREATE INDEX IF NOT EXISTS ix_exp_claim_claimant ON expense_claims(org_id, claimant_user_id);
CREATE INDEX IF NOT EXISTS ix_exp_claim_project ON expense_claims(project_id);

CREATE TABLE IF NOT EXISTS expense_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  claim_id            UUID NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  line_no             INTEGER NOT NULL,
  category            VARCHAR(30) NOT NULL,
  expense_date        DATE NOT NULL,
  description         TEXT NOT NULL,
  amount              NUMERIC(18,2) NOT NULL,
  -- Days, nights or kilometres for an entitlement category.
  units               NUMERIC(10,2),
  currency            CHAR(3) NOT NULL DEFAULT 'INR',
  receipt_document_id UUID,
  vendor_name         VARCHAR(200),
  vendor_gstin        VARCHAR(15),
  invoice_no          VARCHAR(50),
  gst_amount          NUMERIC(18,2),
  supply_state_code   VARCHAR(2),
  gst_creditable      BOOLEAN NOT NULL DEFAULT false,
  credit_block_reason VARCHAR(40),
  billable_to_client  BOOLEAN NOT NULL DEFAULT false,
  project_id          UUID REFERENCES projects(id),
  cost_head_id        UUID REFERENCES cost_heads(id),
  allowed_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
  excess_amount       NUMERIC(18,2) NOT NULL DEFAULT 0,
  policy_exception    BOOLEAN NOT NULL DEFAULT false,
  exception_notes     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_exp_line_category CHECK (category IN
    ('TRAVEL','LODGING','FUEL','PER_DIEM','SITE_MATERIALS_PETTY',
     'CLIENT_ENTERTAINMENT','COMMUNICATION','OTHER')),
  CONSTRAINT chk_exp_line_amount CHECK (amount >= 0),
  CONSTRAINT chk_exp_line_gst CHECK (gst_amount IS NULL OR gst_amount <= amount),
  -- A line charged to a project has to say which project.
  CONSTRAINT chk_exp_line_billable CHECK (NOT billable_to_client OR project_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_exp_line_no ON expense_lines(claim_id, line_no);
CREATE INDEX IF NOT EXISTS ix_exp_line_category ON expense_lines(org_id, category, expense_date);

-- ------------------------------------------------- duplicate bill control

-- The commonest expense fraud in field operations is one fuel bill claimed by
-- two engineers, or the same bill re-submitted a month later. A bill that
-- identifies itself (supplier plus invoice number plus amount) can only be
-- claimed once in an organisation.
CREATE TABLE IF NOT EXISTS expense_receipt_fingerprints (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  fingerprint  VARCHAR(300) NOT NULL,
  line_id      UUID NOT NULL REFERENCES expense_lines(id) ON DELETE CASCADE,
  claim_id     UUID NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_exp_fingerprint ON expense_receipt_fingerprints(org_id, fingerprint);

-- --------------------------------------------------------- reimbursement

-- §16.3 asks for reimbursement to appear as an internal payable. Until the
-- full payment-records module (§15.4) exists, this is that record: without it
-- "Reimbursed" is a status flag with no money behind it, and finance cannot
-- answer what the company owes its own staff.
CREATE TABLE IF NOT EXISTS expense_reimbursements (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id),
  claim_id   UUID NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  amount     NUMERIC(18,2) NOT NULL,
  paid_on    DATE NOT NULL,
  mode       VARCHAR(20) NOT NULL,
  reference  VARCHAR(100),
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  CONSTRAINT chk_exp_reimb_amount CHECK (amount > 0),
  CONSTRAINT chk_exp_reimb_mode CHECK (mode IN ('NEFT','RTGS','IMPS','UPI','CHEQUE','CASH','PAYROLL'))
);

CREATE INDEX IF NOT EXISTS ix_exp_reimb_claim ON expense_reimbursements(claim_id);

-- ------------------------------------ the organisation's own registrations

-- A contractor working across states holds one GSTIN per state, and the
-- lodging-credit rule at §16 needs the whole set: a Karnataka company cannot
-- take Delhi CGST+SGST on a Delhi hotel bill unless it is registered there.
-- Until now the organisation's own registration existed only as a single
-- `organizations.primary_gstin`, which cannot express that.
--
-- party_gst_registrations already models exactly this for clients and vendors,
-- so the organisation joins them rather than getting a parallel table.
DO $$
BEGIN
  ALTER TABLE party_gst_registrations DROP CONSTRAINT chk_pgr_party;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE party_gst_registrations
  ADD CONSTRAINT chk_pgr_party CHECK (party_type IN ('CLIENT','VENDOR','ORGANIZATION'));

-- Carry the single registration each organisation already has into the table,
-- so the new rule has something to work with on day one.
INSERT INTO party_gst_registrations(org_id, party_type, party_id, gstin, state_code, is_primary, status)
SELECT id, 'ORGANIZATION', id, primary_gstin, primary_state_code, true, 'ACTIVE'
FROM organizations
WHERE primary_gstin IS NOT NULL AND primary_state_code IS NOT NULL
ON CONFLICT DO NOTHING;
