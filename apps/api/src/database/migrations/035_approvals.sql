-- Approval workflow over a Delegation of Authority matrix (§41, §22.1, §4.1).
--
-- Built before procurement rather than after, because purchase requisitions,
-- purchase orders, vendor invoices, expense claims, payment release, RA bill
-- certification and above-threshold tender submission all route through the
-- same ladder. Building procurement first means building its approvals twice.
--
-- The instance is deliberately polymorphic over (document_type, document_id)
-- rather than carrying a nullable foreign key per document type. A new
-- document type then needs no schema change, and the alternative — fourteen
-- mostly-null columns — makes "which document is this for" unanswerable
-- without checking all of them.

CREATE TABLE IF NOT EXISTS approval_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  document_type  VARCHAR(30) NOT NULL,
  name           VARCHAR(150) NOT NULL,
  -- SINGLE routes to the one authority whose band holds the amount.
  -- CUMULATIVE routes through every level up to it, which is the Indian
  -- procurement norm: a 6 lakh order is seen by the PM *and* the finance head.
  mode           VARCHAR(20) NOT NULL DEFAULT 'CUMULATIVE',
  -- A project-specific policy wins over the organisation default.
  project_id     UUID REFERENCES projects(id),
  -- Percent by which an amount may drift before approvals are torn up;
  -- freight or rounding on a PO should not restart the ladder.
  tolerance_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     UUID,
  CONSTRAINT chk_ap_mode CHECK (mode IN ('SINGLE','CUMULATIVE')),
  CONSTRAINT chk_ap_doc_type CHECK (document_type IN (
    'PURCHASE_REQUISITION','PURCHASE_ORDER','VENDOR_INVOICE','EXPENSE_CLAIM',
    'PAYMENT','RA_BILL','TENDER_SUBMISSION','LEAVE_REQUEST','ADVANCE','RETENTION_RELEASE')),
  CONSTRAINT chk_ap_tolerance CHECK (tolerance_pct BETWEEN 0 AND 25)
);

-- One active organisation-wide policy per document type, and at most one
-- override per project. Two active policies would make routing ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uk_ap_org_default
  ON approval_policies(org_id, document_type) WHERE active AND project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_ap_project
  ON approval_policies(org_id, document_type, project_id) WHERE active AND project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_levels (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  policy_id         UUID NOT NULL REFERENCES approval_policies(id) ON DELETE CASCADE,
  sequence          INTEGER NOT NULL,
  min_amount        NUMERIC(18,2) NOT NULL,
  -- NULL means "and above"; only the top slab may leave it open.
  max_amount        NUMERIC(18,2),
  approver_role     VARCHAR(50),
  approver_user_id  UUID REFERENCES users(id),
  sla_hours         INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_al_sequence CHECK (sequence BETWEEN 1 AND 20),
  CONSTRAINT chk_al_bounds CHECK (min_amount >= 0 AND (max_amount IS NULL OR max_amount > min_amount)),
  CONSTRAINT chk_al_sla CHECK (sla_hours IS NULL OR sla_hours BETWEEN 1 AND 8760),
  -- A level nobody is assigned to is a dead end in the ladder.
  CONSTRAINT chk_al_approver CHECK (approver_role IS NOT NULL OR approver_user_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_al_sequence ON approval_levels(policy_id, sequence);
CREATE INDEX IF NOT EXISTS ix_al_policy ON approval_levels(policy_id, min_amount);

-- ------------------------------------------------------------- instances

CREATE TABLE IF NOT EXISTS approval_instances (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  document_type     VARCHAR(30) NOT NULL,
  document_id       UUID NOT NULL,
  policy_id         UUID NOT NULL REFERENCES approval_policies(id),
  project_id        UUID REFERENCES projects(id),
  -- The figure the ladder was drawn from. Held so a later edit can be compared
  -- against what was actually approved (§41.3 re-routing).
  amount            NUMERIC(18,2) NOT NULL,
  requested_by      UUID NOT NULL REFERENCES users(id),
  status            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  current_sequence  INTEGER,
  decided_at        TIMESTAMPTZ,
  rejection_reason  TEXT,
  recalled_reason   TEXT,
  -- Set when a material change tore this instance up in favour of a new one.
  superseded_by     UUID REFERENCES approval_instances(id),
  superseded_reason TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  CONSTRAINT chk_ai_status CHECK (status IN ('PENDING','APPROVED','REJECTED','RECALLED','SUPERSEDED')),
  CONSTRAINT chk_ai_amount CHECK (amount >= 0),
  CONSTRAINT chk_ai_rejection CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CONSTRAINT chk_ai_recall CHECK (status <> 'RECALLED' OR recalled_reason IS NOT NULL),
  CONSTRAINT chk_ai_superseded CHECK (
    status <> 'SUPERSEDED' OR (superseded_by IS NOT NULL AND superseded_reason IS NOT NULL)
  )
);

-- One live approval per document. A second would let the same document be
-- approved twice down different ladders.
CREATE UNIQUE INDEX IF NOT EXISTS uk_ai_live_document
  ON approval_instances(document_type, document_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_ai_document ON approval_instances(document_type, document_id);
CREATE INDEX IF NOT EXISTS ix_ai_requester ON approval_instances(org_id, requested_by, status);

CREATE TABLE IF NOT EXISTS approval_steps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  instance_id       UUID NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
  sequence          INTEGER NOT NULL,
  approver_role     VARCHAR(50),
  approver_user_id  UUID REFERENCES users(id),
  sla_hours         INTEGER,
  status            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  pending_since     TIMESTAMPTZ,
  acted_by          UUID REFERENCES users(id),
  acted_at          TIMESTAMPTZ,
  -- Records that the act was taken on delegated authority, and from whom.
  acted_on_behalf_of UUID REFERENCES users(id),
  comments          TEXT,
  escalated_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_as_status CHECK (status IN ('PENDING','APPROVED','REJECTED','SKIPPED')),
  -- A decided step must say who decided it; that is the audit record (§20.3).
  CONSTRAINT chk_as_decided CHECK (
    status = 'PENDING' OR status = 'SKIPPED' OR (acted_by IS NOT NULL AND acted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_as_sequence ON approval_steps(instance_id, sequence);
-- The approver's queue, and the escalation sweep.
CREATE INDEX IF NOT EXISTS ix_as_pending_role
  ON approval_steps(org_id, approver_role) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_as_pending_user
  ON approval_steps(org_id, approver_user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_as_sla
  ON approval_steps(pending_since) WHERE status = 'PENDING' AND sla_hours IS NOT NULL;

-- ------------------------------------------------------------ delegation

CREATE TABLE IF NOT EXISTS approval_delegations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  from_user_id    UUID NOT NULL REFERENCES users(id),
  to_user_id      UUID NOT NULL REFERENCES users(id),
  valid_from      DATE NOT NULL,
  valid_to        DATE NOT NULL,
  -- Empty means every document type.
  document_types  JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason          TEXT NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID,
  -- Delegating to yourself is a no-op that looks like authority.
  CONSTRAINT chk_ad_distinct CHECK (from_user_id <> to_user_id),
  CONSTRAINT chk_ad_window CHECK (valid_to >= valid_from),
  -- §4.1 audit: a delegation of authority must say why it exists.
  CONSTRAINT chk_ad_reason CHECK (length(trim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS ix_ad_from
  ON approval_delegations(from_user_id, valid_from, valid_to) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_ad_to
  ON approval_delegations(to_user_id) WHERE revoked_at IS NULL;

-- Permissions (§4.2).
INSERT INTO permissions (code, description, module) VALUES
  ('approval.read',         'View approval requests you raised',             'approval'),
  ('approval.read_all',     'View every approval request in the organisation','approval'),
  ('approval.configure',    'Define approval policies and authority slabs',  'approval'),
  ('approval.act',          'Approve or reject a request at your level',     'approval'),
  ('approval.delegate',     'Delegate your approval authority for a period', 'approval'),
  ('approval.self_approve', 'Emergency override of maker-checker, audited',  'approval')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.code
FROM roles r
JOIN (VALUES
  -- §4.1 reserves the emergency self-approval override for the top role.
  ('SUPER_ADMIN','approval.read'),('SUPER_ADMIN','approval.read_all'),('SUPER_ADMIN','approval.configure'),
  ('SUPER_ADMIN','approval.act'),('SUPER_ADMIN','approval.delegate'),
  ('SUPER_ADMIN','approval.self_approve'),

  ('ADMIN','approval.read'),('ADMIN','approval.read_all'),('ADMIN','approval.configure'),
  ('ADMIN','approval.act'),('ADMIN','approval.delegate'),

  ('PROJECT_MANAGER','approval.read'),('PROJECT_MANAGER','approval.read_all'),('PROJECT_MANAGER','approval.act'),('PROJECT_MANAGER','approval.delegate'),
  ('TEAM_LEAD','approval.read'),('TEAM_LEAD','approval.read_all'),('TEAM_LEAD','approval.act'),
  ('BID_TENDER_MANAGER','approval.read'),('BID_TENDER_MANAGER','approval.read_all'),('BID_TENDER_MANAGER','approval.act'),
  ('HR_MANAGER','approval.read'),('HR_MANAGER','approval.read_all'),('HR_MANAGER','approval.act'),
  ('PAYROLL_OFFICER','approval.read'),('PAYROLL_OFFICER','approval.read_all'),('PAYROLL_OFFICER','approval.act'),
  ('INVENTORY_MANAGER','approval.read'),('INVENTORY_MANAGER','approval.read_all'),('INVENTORY_MANAGER','approval.act'),
  ('AUDITOR','approval.read'),('AUDITOR','approval.read_all'),
  -- Sees the progress of what they raised; the route scopes it to their own.
  ('EMPLOYEE','approval.read'),
  ('SALES_BD_EXECUTIVE','approval.read')
) AS g(role_code, code) ON g.role_code = r.code
ON CONFLICT DO NOTHING;
