-- Procurement: requisition → order → receipt → invoice (§6.6, §13.2, §43).
--
-- The chain exists to answer one question before money leaves: did we order
-- this, did it arrive, and does the bill match? Every structure here serves
-- that three-way match.
--
-- Received quantity is NOT stored on the order line. An order is received
-- across several GRNs, so the position is summed from the receipts. Keeping a
-- running total on the line as well gives two writers a number to disagree
-- about, and they eventually do.

CREATE TABLE IF NOT EXISTS purchase_requisitions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  requisition_no   VARCHAR(50) NOT NULL,
  project_id       UUID REFERENCES projects(id),
  requested_by     UUID NOT NULL REFERENCES users(id),
  required_by      DATE,
  justification    TEXT NOT NULL,
  estimated_value  NUMERIC(18,2) NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  -- The approval instance that routed it (§41). Null while still a draft.
  approval_id      UUID REFERENCES approval_instances(id),
  rejection_reason TEXT,
  cancelled_reason TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID,
  CONSTRAINT chk_pr_status CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','CONVERTED','CANCELLED')),
  CONSTRAINT chk_pr_justification CHECK (length(trim(justification)) > 0),
  CONSTRAINT chk_pr_rejection CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CONSTRAINT chk_pr_cancel CHECK (status <> 'CANCELLED' OR cancelled_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_pr_no ON purchase_requisitions(org_id, requisition_no);
CREATE INDEX IF NOT EXISTS ix_pr_status ON purchase_requisitions(org_id, status);
CREATE INDEX IF NOT EXISTS ix_pr_project ON purchase_requisitions(project_id);

CREATE TABLE IF NOT EXISTS requisition_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  requisition_id  UUID NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  item_id         UUID REFERENCES inventory_items(id),
  description     TEXT NOT NULL,
  unit            VARCHAR(20) NOT NULL,
  quantity        NUMERIC(16,3) NOT NULL,
  estimated_rate  NUMERIC(16,4),
  remarks         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rl_quantity CHECK (quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_rl_line_no ON requisition_lines(requisition_id, line_no);

-- ---------------------------------------------------------- purchase order

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  po_number         VARCHAR(50) NOT NULL,
  vendor_id         UUID NOT NULL REFERENCES vendors(id),
  requisition_id    UUID REFERENCES purchase_requisitions(id),
  project_id        UUID REFERENCES projects(id),
  po_date           DATE NOT NULL,
  delivery_date     DATE,
  payment_terms     VARCHAR(200),
  delivery_address  TEXT,
  place_of_supply   VARCHAR(2),
  taxable_value     NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_value       NUMERIC(18,2) NOT NULL DEFAULT 0,
  status            VARCHAR(25) NOT NULL DEFAULT 'DRAFT',
  approval_id       UUID REFERENCES approval_instances(id),
  -- §6.6: an order exceeding its requisition needs an authorised override,
  -- recorded on the order rather than only in the audit log.
  scope_override_by     UUID REFERENCES users(id),
  scope_override_reason TEXT,
  scope_override_at     TIMESTAMPTZ,
  -- Bumped by each amendment; the revision is part of the document identity
  -- once it has been sent to a vendor.
  revision          INTEGER NOT NULL DEFAULT 0,
  closed_reason     TEXT,
  cancelled_reason  TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  CONSTRAINT chk_po_status CHECK (status IN
    ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','PARTIALLY_RECEIVED','FULLY_RECEIVED','CLOSED','CANCELLED')),
  CONSTRAINT chk_po_override CHECK (
    (scope_override_by IS NULL AND scope_override_reason IS NULL AND scope_override_at IS NULL)
    OR (scope_override_by IS NOT NULL AND scope_override_reason IS NOT NULL AND scope_override_at IS NOT NULL)
  ),
  CONSTRAINT chk_po_cancel CHECK (status <> 'CANCELLED' OR cancelled_reason IS NOT NULL),
  CONSTRAINT chk_po_dates CHECK (delivery_date IS NULL OR delivery_date >= po_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_po_number ON purchase_orders(org_id, po_number);
CREATE INDEX IF NOT EXISTS ix_po_vendor ON purchase_orders(org_id, vendor_id);
CREATE INDEX IF NOT EXISTS ix_po_status ON purchase_orders(org_id, status);
-- Open orders: the "what is still due to arrive" report.
CREATE INDEX IF NOT EXISTS ix_po_open
  ON purchase_orders(org_id, delivery_date)
  WHERE status IN ('SENT','PARTIALLY_RECEIVED');

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id),
  purchase_order_id    UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no              INTEGER NOT NULL,
  item_id              UUID REFERENCES inventory_items(id),
  requisition_line_id  UUID REFERENCES requisition_lines(id),
  description          TEXT NOT NULL,
  hsn_sac              VARCHAR(10),
  unit                 VARCHAR(20) NOT NULL,
  quantity             NUMERIC(16,3) NOT NULL,
  unit_rate            NUMERIC(16,4) NOT NULL,
  gst_rate_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
  taxable_value        NUMERIC(18,2) NOT NULL,
  tax_amount           NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total           NUMERIC(18,2) NOT NULL,
  remarks              TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pol_quantity CHECK (quantity > 0),
  CONSTRAINT chk_pol_rate CHECK (unit_rate >= 0),
  CONSTRAINT chk_pol_hsn CHECK (hsn_sac IS NULL OR hsn_sac ~ '^[0-9]{4,8}$'),
  CONSTRAINT chk_pol_gst_rate CHECK (gst_rate_pct IN (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_pol_line_no ON purchase_order_lines(purchase_order_id, line_no);
CREATE INDEX IF NOT EXISTS ix_pol_po ON purchase_order_lines(purchase_order_id);

-- §43.2 amendments. Kept as their own record rather than editing in place, so
-- the vendor-facing revision history survives and a value change can be tied
-- to the approval it triggered.
CREATE TABLE IF NOT EXISTS po_amendments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL,
  reason            TEXT NOT NULL,
  previous_total    NUMERIC(18,2) NOT NULL,
  new_total         NUMERIC(18,2) NOT NULL,
  changes           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The fresh approval a material change forced (§41 re-routing).
  approval_id       UUID REFERENCES approval_instances(id),
  amended_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_poa_reason CHECK (length(trim(reason)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_poa_revision ON po_amendments(purchase_order_id, revision);

-- ------------------------------------------------------------------- GRN

CREATE TABLE IF NOT EXISTS goods_receipt_notes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  grn_no            VARCHAR(50) NOT NULL,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id),
  received_date     DATE NOT NULL,
  challan_no        VARCHAR(50),
  vehicle_no        VARCHAR(20),
  received_by       UUID NOT NULL REFERENCES users(id),
  -- Set when the receipt exceeded the order and somebody accepted it anyway.
  over_receipt_reason TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
  remarks           TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  CONSTRAINT chk_grn_status CHECK (status IN ('RECEIVED','CANCELLED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_grn_no ON goods_receipt_notes(org_id, grn_no);
CREATE INDEX IF NOT EXISTS ix_grn_po ON goods_receipt_notes(purchase_order_id);

CREATE TABLE IF NOT EXISTS grn_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  grn_id            UUID NOT NULL REFERENCES goods_receipt_notes(id) ON DELETE CASCADE,
  po_line_id        UUID NOT NULL REFERENCES purchase_order_lines(id),
  received_quantity NUMERIC(16,3) NOT NULL,
  accepted_quantity NUMERIC(16,3) NOT NULL,
  rejection_reason  TEXT,
  remarks           TEXT,
  -- The stock movement this receipt produced, so inventory and procurement
  -- reconcile without inferring the link.
  stock_transaction_id UUID REFERENCES stock_transactions(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_gl_quantities CHECK (received_quantity >= 0 AND accepted_quantity >= 0),
  -- Accepting more than arrived is arithmetic, not judgement.
  CONSTRAINT chk_gl_accepted CHECK (accepted_quantity <= received_quantity),
  -- An unexplained rejection is the one the vendor disputes.
  CONSTRAINT chk_gl_rejection CHECK (
    received_quantity = accepted_quantity OR rejection_reason IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_gl_grn_line ON grn_lines(grn_id, po_line_id);
CREATE INDEX IF NOT EXISTS ix_gl_po_line ON grn_lines(po_line_id);

-- --------------------------------------------------------- 3-way match log
--
-- The result is recorded rather than recomputed on demand: a payment released
-- against an override must keep the evidence of what was overridden and by
-- whom, and recomputing later against changed data would rewrite history.

CREATE TABLE IF NOT EXISTS invoice_match_results (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  invoice_id        UUID NOT NULL REFERENCES invoices(id),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id),
  matched           BOOLEAN NOT NULL,
  exceptions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ordered_value     NUMERIC(18,2) NOT NULL,
  received_value    NUMERIC(18,2) NOT NULL,
  invoiced_value    NUMERIC(18,2) NOT NULL,
  override_by       UUID REFERENCES users(id),
  override_reason   TEXT,
  override_at       TIMESTAMPTZ,
  checked_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_imr_override CHECK (
    (override_by IS NULL AND override_reason IS NULL AND override_at IS NULL)
    OR (override_by IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL)
  ),
  -- Overriding a match that passed is meaningless and hides why it exists.
  CONSTRAINT chk_imr_override_only_on_failure CHECK (override_by IS NULL OR NOT matched)
);

CREATE INDEX IF NOT EXISTS ix_imr_invoice ON invoice_match_results(invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_imr_po ON invoice_match_results(purchase_order_id);

-- Link a vendor invoice to the order it settles.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES purchase_orders(id),
  ADD COLUMN IF NOT EXISTS grn_id            UUID REFERENCES goods_receipt_notes(id),
  ADD COLUMN IF NOT EXISTS match_status      VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED';

DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT chk_inv_match_status
    CHECK (match_status IN ('UNMATCHED','MATCHED','EXCEPTION','OVERRIDDEN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ix_invoices_po ON invoices(purchase_order_id);

INSERT INTO permissions (code, description, module) VALUES
  ('requisition.read',   'View purchase requisitions',                    'procurement'),
  ('requisition.manage', 'Raise and submit purchase requisitions',        'procurement'),
  ('po.read',            'View purchase orders',                          'procurement'),
  ('po.manage',          'Create and issue purchase orders',              'procurement'),
  ('po.amend',           'Amend an issued purchase order',                'procurement'),
  ('grn.read',           'View goods receipt notes',                      'procurement'),
  ('grn.manage',         'Record receipt of goods',                       'procurement'),
  ('match.read',         'View three-way match results',                  'procurement'),
  ('match.override',     'Release payment against a mismatched invoice',  'procurement')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.code
FROM roles r
JOIN (VALUES
  ('SUPER_ADMIN','requisition.read'),('SUPER_ADMIN','requisition.manage'),
  ('SUPER_ADMIN','po.read'),('SUPER_ADMIN','po.manage'),('SUPER_ADMIN','po.amend'),
  ('SUPER_ADMIN','grn.read'),('SUPER_ADMIN','grn.manage'),
  ('SUPER_ADMIN','match.read'),('SUPER_ADMIN','match.override'),

  -- §4.1: the role that raises orders must not hold the control that releases
  -- payment against a mismatched invoice.
  ('ADMIN','requisition.read'),('ADMIN','requisition.manage'),
  ('ADMIN','po.read'),('ADMIN','po.manage'),('ADMIN','po.amend'),
  ('ADMIN','grn.read'),('ADMIN','grn.manage'),('ADMIN','match.read'),

  -- Requisitions for their site and receives material; ordering is the
  -- procurement function, not the project manager's.
  ('PROJECT_MANAGER','requisition.read'),('PROJECT_MANAGER','requisition.manage'),
  ('PROJECT_MANAGER','po.read'),('PROJECT_MANAGER','grn.read'),('PROJECT_MANAGER','grn.manage'),
  ('PROJECT_MANAGER','match.read'),

  ('TEAM_LEAD','requisition.read'),('TEAM_LEAD','requisition.manage'),
  ('TEAM_LEAD','po.read'),('TEAM_LEAD','grn.read'),

  ('INVENTORY_MANAGER','requisition.read'),('INVENTORY_MANAGER','po.read'),
  ('INVENTORY_MANAGER','grn.read'),('INVENTORY_MANAGER','grn.manage'),('INVENTORY_MANAGER','match.read'),

  ('AUDITOR','requisition.read'),('AUDITOR','po.read'),('AUDITOR','grn.read'),('AUDITOR','match.read'),
  ('BID_TENDER_MANAGER','requisition.read'),('BID_TENDER_MANAGER','po.read')
) AS g(role_code, code) ON g.role_code = r.code
ON CONFLICT DO NOTHING;
