-- Running-account billing, BOQ and retention (§6.7, §15, §37.3).
--
-- The specification has a RetentionRecord and assumes milestone invoicing.
-- Indian EPC and infrastructure contracts do not bill that way. Work is
-- measured periodically and each bill claims the CUMULATIVE quantity executed
-- to date less everything already billed, with retention and statutory
-- deductions withheld from the payment.
--
-- The central decision here: a bill line stores the cumulative quantity, not
-- the increment. A re-measurement then corrects the running total and every
-- later bill stays consistent. Storing increments means a revision to one bill
-- silently misstates the contract position, and the error only surfaces at
-- final reconciliation when it is expensive to unpick.

CREATE TABLE IF NOT EXISTS boq_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  project_id    UUID NOT NULL REFERENCES projects(id),
  item_code     VARCHAR(50) NOT NULL,
  section       VARCHAR(150),
  description   TEXT NOT NULL,
  unit          VARCHAR(20) NOT NULL,
  quantity      NUMERIC(16,3) NOT NULL,
  rate          NUMERIC(16,4) NOT NULL,
  -- Held rather than derived: a BOQ amount is a contracted figure, and
  -- recomputing it from quantity x rate can drift by a paisa against the
  -- signed document.
  amount        NUMERIC(18,2) NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  CONSTRAINT chk_boq_quantity CHECK (quantity > 0),
  CONSTRAINT chk_boq_rate CHECK (rate >= 0),
  CONSTRAINT chk_boq_status CHECK (status IN ('ACTIVE','SUPERSEDED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_boq_item_code
  ON boq_items(project_id, item_code) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_boq_project ON boq_items(project_id, sort_order);

-- ------------------------------------------------------- deduction policy
--
-- Held per project because the heads differ by contract: a government client
-- deducts GST TDS under s.51 CGST Act, a private one does not; labour cess
-- applies to construction above the notified threshold and not to supply-only
-- work. Defaulting these globally would quietly short-pay somebody.

CREATE TABLE IF NOT EXISTS project_billing_policies (
  project_id                   UUID PRIMARY KEY REFERENCES projects(id),
  org_id                       UUID NOT NULL REFERENCES organizations(id),
  retention_pct                NUMERIC(5,2),
  retention_cap_pct_of_contract NUMERIC(5,2),
  security_deposit_pct         NUMERIC(5,2),
  labour_cess_pct              NUMERIC(5,2),
  tds_income_tax_pct           NUMERIC(5,2),
  tds_gst_pct                  NUMERIC(5,2),
  gst_rate_pct                 NUMERIC(5,2),
  -- Defect liability period, the gate on releasing retention (§6.7).
  dlp_months                   INTEGER,
  dlp_end_date                 DATE,
  retention_first_tranche_pct  NUMERIC(5,2),
  version                      INTEGER NOT NULL DEFAULT 1,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                   UUID,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                   UUID,
  CONSTRAINT chk_pbp_pcts CHECK (
    coalesce(retention_pct,0) BETWEEN 0 AND 100
    AND coalesce(security_deposit_pct,0) BETWEEN 0 AND 100
    AND coalesce(labour_cess_pct,0) BETWEEN 0 AND 10
    AND coalesce(tds_income_tax_pct,0) BETWEEN 0 AND 30
    AND coalesce(tds_gst_pct,0) BETWEEN 0 AND 10
    AND coalesce(gst_rate_pct,0) BETWEEN 0 AND 40
    AND coalesce(retention_first_tranche_pct,0) BETWEEN 0 AND 100
  )
);

-- --------------------------------------------------------------- advances
--
-- A mobilisation advance is paid up front against a bank guarantee and
-- recovered pro-rata from each bill. The outstanding balance is what the
-- contractor still owes back, and it must never go negative.

CREATE TABLE IF NOT EXISTS project_advances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  project_id          UUID NOT NULL REFERENCES projects(id),
  advance_type        VARCHAR(20) NOT NULL,
  amount              NUMERIC(18,2) NOT NULL,
  paid_on             DATE NOT NULL,
  recovery_pct        NUMERIC(5,2) NOT NULL,
  recovered_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  bank_guarantee_id   UUID REFERENCES bank_guarantee_instruments(id),
  remarks             TEXT,
  status              VARCHAR(20) NOT NULL DEFAULT 'OUTSTANDING',
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID,
  CONSTRAINT chk_advance_type CHECK (advance_type IN ('MOBILISATION','MATERIAL','PLANT')),
  CONSTRAINT chk_advance_amount CHECK (amount > 0),
  CONSTRAINT chk_advance_recovery_pct CHECK (recovery_pct > 0 AND recovery_pct <= 100),
  CONSTRAINT chk_advance_status CHECK (status IN ('OUTSTANDING','RECOVERED','WAIVED')),
  -- Recovering more than was advanced would leave the contractor owing money
  -- back, which is an arithmetic error rather than a business outcome.
  CONSTRAINT chk_advance_not_over_recovered CHECK (recovered_amount >= 0 AND recovered_amount <= amount)
);

CREATE INDEX IF NOT EXISTS ix_advances_project
  ON project_advances(project_id) WHERE status = 'OUTSTANDING';

-- --------------------------------------------------------------- RA bills

CREATE TABLE IF NOT EXISTS ra_bills (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  project_id          UUID NOT NULL REFERENCES projects(id),
  -- Sequential within the project: RA-1, RA-2, ... then the final bill.
  bill_no             INTEGER NOT NULL,
  bill_type           VARCHAR(10) NOT NULL DEFAULT 'RA',
  period_from         DATE NOT NULL,
  period_to           DATE NOT NULL,
  measurement_book_ref VARCHAR(100),

  -- Money, all derived from the lines and the policy at certification time and
  -- then frozen. A certified bill must not change because a policy percentage
  -- was edited afterwards.
  cumulative_value    NUMERIC(18,2) NOT NULL DEFAULT 0,
  previous_value      NUMERIC(18,2) NOT NULL DEFAULT 0,
  gross_value         NUMERIC(18,2) NOT NULL DEFAULT 0,
  gst_amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_deductions    NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_payable         NUMERIC(18,2) NOT NULL DEFAULT 0,

  status              VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  submitted_at        TIMESTAMPTZ,
  certified_at        TIMESTAMPTZ,
  certified_by        UUID REFERENCES users(id),
  certified_amount    NUMERIC(18,2),
  paid_at             TIMESTAMPTZ,
  cancelled_reason    TEXT,
  remarks             TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID,
  CONSTRAINT chk_ra_type CHECK (bill_type IN ('RA','FINAL')),
  CONSTRAINT chk_ra_status CHECK (status IN ('DRAFT','SUBMITTED','CERTIFIED','PAID','CANCELLED')),
  CONSTRAINT chk_ra_period CHECK (period_to >= period_from),
  CONSTRAINT chk_ra_bill_no CHECK (bill_no > 0),
  -- A certified bill is a receivable; the certifying actor and amount are the
  -- audit record of who accepted what (§20.3).
  CONSTRAINT chk_ra_certified_complete CHECK (
    status NOT IN ('CERTIFIED','PAID')
    OR (certified_at IS NOT NULL AND certified_by IS NOT NULL AND certified_amount IS NOT NULL)
  ),
  CONSTRAINT chk_ra_cancelled_reason CHECK (status <> 'CANCELLED' OR cancelled_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_ra_bill_no ON ra_bills(project_id, bill_no);
-- Two open measurements on one project means two people are billing the same
-- work; only one bill may be in progress at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uk_ra_one_open
  ON ra_bills(project_id) WHERE status IN ('DRAFT','SUBMITTED');
-- The final bill closes the account: there can be only one, and nothing
-- follows it.
CREATE UNIQUE INDEX IF NOT EXISTS uk_ra_one_final
  ON ra_bills(project_id) WHERE bill_type = 'FINAL' AND status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS ix_ra_project_status ON ra_bills(project_id, status);

CREATE TABLE IF NOT EXISTS ra_bill_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  ra_bill_id          UUID NOT NULL REFERENCES ra_bills(id) ON DELETE CASCADE,
  boq_item_id         UUID NOT NULL REFERENCES boq_items(id),
  -- The running total measured to date. The increment is derived.
  cumulative_quantity NUMERIC(16,3) NOT NULL,
  previous_quantity   NUMERIC(16,3) NOT NULL DEFAULT 0,
  rate                NUMERIC(16,4) NOT NULL,
  cumulative_amount   NUMERIC(18,2) NOT NULL,
  previous_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  this_amount         NUMERIC(18,2) NOT NULL,
  -- Executed beyond the BOQ provision; certifying it needs a deviation order.
  excess_quantity     NUMERIC(16,3) NOT NULL DEFAULT 0,
  deviation_approved_by UUID REFERENCES users(id),
  deviation_reason    TEXT,
  remarks             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rbi_cumulative CHECK (cumulative_quantity >= 0),
  CONSTRAINT chk_rbi_deviation CHECK (
    deviation_approved_by IS NULL OR deviation_reason IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_rbi_bill_item ON ra_bill_items(ra_bill_id, boq_item_id);
CREATE INDEX IF NOT EXISTS ix_rbi_boq ON ra_bill_items(boq_item_id);

CREATE TABLE IF NOT EXISTS ra_bill_deductions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  ra_bill_id    UUID NOT NULL REFERENCES ra_bills(id) ON DELETE CASCADE,
  head          VARCHAR(30) NOT NULL,
  label         VARCHAR(150) NOT NULL,
  basis         VARCHAR(10) NOT NULL,
  rate_pct      NUMERIC(6,3),
  amount        NUMERIC(18,2) NOT NULL,
  -- Which advance this instalment paid down, so the ledger reconciles.
  advance_id    UUID REFERENCES project_advances(id),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rbd_head CHECK (head IN (
    'RETENTION','SECURITY_DEPOSIT','LABOUR_CESS','TDS_INCOME_TAX','TDS_GST',
    'MOBILISATION_ADVANCE','MATERIAL_ADVANCE','LIQUIDATED_DAMAGES','PENALTY','OTHER')),
  CONSTRAINT chk_rbd_basis CHECK (basis IN ('GROSS','FIXED')),
  CONSTRAINT chk_rbd_amount CHECK (amount > 0),
  -- A discretionary recovery must say why; that is the line the client
  -- disputes, and an unexplained one cannot be defended.
  CONSTRAINT chk_rbd_reason CHECK (
    head NOT IN ('LIQUIDATED_DAMAGES','PENALTY','OTHER') OR reason IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS ix_rbd_bill ON ra_bill_deductions(ra_bill_id);
CREATE INDEX IF NOT EXISTS ix_rbd_advance ON ra_bill_deductions(advance_id) WHERE advance_id IS NOT NULL;

-- ------------------------------------------------------- retention ledger
--
-- §6.7: retention cannot be marked eligible for release before the DLP ends.
-- Held as a ledger rather than a single balance so a partial release leaves
-- an auditable trail of what was released when and against which bill.

CREATE TABLE IF NOT EXISTS retention_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  project_id    UUID NOT NULL REFERENCES projects(id),
  ra_bill_id    UUID REFERENCES ra_bills(id),
  entry_type    VARCHAR(20) NOT NULL,
  amount        NUMERIC(18,2) NOT NULL,
  released_at   DATE,
  released_by   UUID REFERENCES users(id),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  CONSTRAINT chk_rl_type CHECK (entry_type IN ('WITHHELD','RELEASED','FORFEITED')),
  CONSTRAINT chk_rl_amount CHECK (amount > 0),
  CONSTRAINT chk_rl_release_complete CHECK (
    entry_type <> 'RELEASED' OR (released_at IS NOT NULL AND released_by IS NOT NULL)
  ),
  CONSTRAINT chk_rl_forfeit_reason CHECK (entry_type <> 'FORFEITED' OR reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_retention_project ON retention_ledger(project_id, created_at);

-- Permissions (§4.2). Finance User owns certification and release; a PM
-- measures and submits but does not certify their own bill (§4.1 segregation).
INSERT INTO permissions (code, description, module) VALUES
  ('boq.read',      'View the bill of quantities',                  'billing'),
  ('boq.manage',    'Create and revise BOQ items',                  'billing'),
  ('rabill.read',   'View running-account bills',                   'billing'),
  ('rabill.manage', 'Measure and submit running-account bills',     'billing'),
  ('rabill.certify','Certify a bill, making it a receivable',       'billing'),
  ('retention.read',   'View the retention ledger',                 'billing'),
  ('retention.release','Release retention after the defect liability period', 'billing')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.code
FROM roles r
JOIN (VALUES
  ('SUPER_ADMIN','boq.read'),('SUPER_ADMIN','boq.manage'),
  ('SUPER_ADMIN','rabill.read'),('SUPER_ADMIN','rabill.manage'),
  ('SUPER_ADMIN','rabill.certify'),
  ('SUPER_ADMIN','retention.read'),('SUPER_ADMIN','retention.release'),

  ('ADMIN','boq.read'),('ADMIN','boq.manage'),
  ('ADMIN','rabill.read'),('ADMIN','rabill.manage'),('ADMIN','rabill.certify'),
  ('ADMIN','retention.read'),('ADMIN','retention.release'),

  -- Measures and submits; certification sits elsewhere (§4.1).
  ('PROJECT_MANAGER','boq.read'),('PROJECT_MANAGER','boq.manage'),
  ('PROJECT_MANAGER','rabill.read'),('PROJECT_MANAGER','rabill.manage'),
  ('PROJECT_MANAGER','retention.read'),

  ('TEAM_LEAD','boq.read'),('TEAM_LEAD','rabill.read'),
  ('AUDITOR','boq.read'),('AUDITOR','rabill.read'),('AUDITOR','retention.read'),
  ('BID_TENDER_MANAGER','boq.read'),('BID_TENDER_MANAGER','rabill.read')
) AS g(role_code, code) ON g.role_code = r.code
ON CONFLICT DO NOTHING;
