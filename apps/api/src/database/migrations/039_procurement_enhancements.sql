-- Procurement enhancements (§43): RFQ, amendments, returns, acknowledgement.
--
-- 038 built the core chain. §43 adds the four areas around it, one of which
-- was a gap left open: po_amendments existed as a table with no endpoint,
-- which is worse than not having it — the schema promises a capability the
-- API cannot deliver.

-- §43.1 competitive sourcing.
CREATE TABLE IF NOT EXISTS rfqs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  rfq_no         VARCHAR(50) NOT NULL,
  requisition_id UUID REFERENCES purchase_requisitions(id),
  project_id     UUID REFERENCES projects(id),
  due_date       DATE NOT NULL,
  scope          TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  -- The award decision, kept with its justification: §43.1 asks for the
  -- selected vendor *and* why, because choosing anyone but L1 needs defending.
  selected_vendor_id UUID REFERENCES vendors(id),
  selection_reason   TEXT,
  selected_by        UUID REFERENCES users(id),
  selected_at        TIMESTAMPTZ,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     UUID,
  CONSTRAINT chk_rfq_status CHECK (status IN ('OPEN','CLOSED','AWARDED','CANCELLED')),
  CONSTRAINT chk_rfq_selection CHECK (
    selected_vendor_id IS NULL
    OR (selection_reason IS NOT NULL AND selected_by IS NOT NULL AND selected_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_rfq_no ON rfqs(org_id, rfq_no);
CREATE INDEX IF NOT EXISTS ix_rfq_status ON rfqs(org_id, status);

CREATE TABLE IF NOT EXISTS rfq_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  rfq_id      UUID NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  item_id     UUID REFERENCES inventory_items(id),
  description TEXT NOT NULL,
  unit        VARCHAR(20) NOT NULL,
  quantity    NUMERIC(16,3) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rfql_quantity CHECK (quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_rfql_line_no ON rfq_lines(rfq_id, line_no);

CREATE TABLE IF NOT EXISTS rfq_vendors (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    UUID NOT NULL REFERENCES organizations(id),
  rfq_id    UUID NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_rfq_vendor ON rfq_vendors(rfq_id, vendor_id);

CREATE TABLE IF NOT EXISTS vendor_quotes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  rfq_id         UUID NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id      UUID NOT NULL REFERENCES vendors(id),
  quote_no       VARCHAR(50),
  quote_date     DATE NOT NULL,
  validity_days  INTEGER,
  freight        NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_charges  NUMERIC(18,2) NOT NULL DEFAULT 0,
  delivery_days  INTEGER,
  payment_terms  VARCHAR(200),
  technically_qualified BOOLEAN NOT NULL DEFAULT TRUE,
  -- Whether GST on this quote can be claimed back. False for a composition or
  -- unregistered supplier, whose tax is a real cost and belongs in the
  -- comparison — ignoring it regularly reverses a ranking.
  gst_creditable BOOLEAN NOT NULL DEFAULT TRUE,
  disqualification_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID,
  CONSTRAINT chk_vq_disqualification CHECK (
    technically_qualified OR disqualification_reason IS NOT NULL
  )
);

-- One quote per vendor per RFQ; a revised quote replaces rather than stacks.
CREATE UNIQUE INDEX IF NOT EXISTS uk_vq_rfq_vendor ON vendor_quotes(rfq_id, vendor_id);

CREATE TABLE IF NOT EXISTS vendor_quote_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  quote_id     UUID NOT NULL REFERENCES vendor_quotes(id) ON DELETE CASCADE,
  rfq_line_id  UUID NOT NULL REFERENCES rfq_lines(id),
  unit_rate    NUMERIC(16,4) NOT NULL,
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  gst_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  remarks      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_vql_rate CHECK (unit_rate >= 0),
  CONSTRAINT chk_vql_discount CHECK (discount_pct BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_vql_quote_line ON vendor_quote_lines(quote_id, rfq_line_id);

-- Link an order back to the RFQ that sourced it, for §37 lineage.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rfq_id UUID REFERENCES rfqs(id);

-- §43.4 vendor acknowledgement.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS acknowledged_on        DATE,
  ADD COLUMN IF NOT EXISTS acknowledged_reference VARCHAR(100),
  ADD COLUMN IF NOT EXISTS promised_delivery_date DATE,
  ADD COLUMN IF NOT EXISTS acknowledgement_exceptions TEXT;

-- §43.3 return to vendor. Inventory and payables move only through controlled
-- transactions, so a return carries its own stock movement rather than editing
-- the original receipt.
CREATE TABLE IF NOT EXISTS vendor_returns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  return_no   VARCHAR(50) NOT NULL,
  grn_id      UUID NOT NULL REFERENCES goods_receipt_notes(id),
  return_date DATE NOT NULL,
  reason      VARCHAR(30) NOT NULL,
  resolution  VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  remarks     TEXT NOT NULL,
  debit_note_no     VARCHAR(50),
  debit_note_amount NUMERIC(18,2),
  returned_by UUID NOT NULL REFERENCES users(id),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  CONSTRAINT chk_vr_reason CHECK (reason IN
    ('QUALITY_REJECTION','SHORT_SUPPLY','EXCESS_SUPPLY','WRONG_ITEM','DAMAGED_IN_TRANSIT','OTHER')),
  CONSTRAINT chk_vr_resolution CHECK (resolution IN ('REPLACEMENT','CREDIT_NOTE','PENDING')),
  CONSTRAINT chk_vr_remarks CHECK (length(trim(remarks)) > 0),
  -- A credit note without its number and value cannot be set against a
  -- payable, so the resolution is not actually resolved.
  CONSTRAINT chk_vr_credit_note CHECK (
    resolution <> 'CREDIT_NOTE' OR (debit_note_no IS NOT NULL AND debit_note_amount IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_vr_no ON vendor_returns(org_id, return_no);
CREATE INDEX IF NOT EXISTS ix_vr_grn ON vendor_returns(grn_id);

CREATE TABLE IF NOT EXISTS vendor_return_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  return_id   UUID NOT NULL REFERENCES vendor_returns(id) ON DELETE CASCADE,
  grn_line_id UUID NOT NULL REFERENCES grn_lines(id),
  quantity    NUMERIC(16,3) NOT NULL,
  remarks     TEXT,
  stock_transaction_id UUID REFERENCES stock_transactions(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_vrl_quantity CHECK (quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_vrl_return_line ON vendor_return_lines(return_id, grn_line_id);
CREATE INDEX IF NOT EXISTS ix_vrl_grn_line ON vendor_return_lines(grn_line_id);

INSERT INTO permissions (code, description, module) VALUES
  ('rfq.read',   'View requests for quotation and comparisons', 'procurement'),
  ('rfq.manage', 'Raise RFQs, record quotes and select a vendor','procurement'),
  ('return.read',   'View returns to vendor',                   'procurement'),
  ('return.manage', 'Return material to a vendor',              'procurement')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, g.code
FROM roles r
JOIN (VALUES
  ('SUPER_ADMIN','rfq.read'),('SUPER_ADMIN','rfq.manage'),
  ('SUPER_ADMIN','return.read'),('SUPER_ADMIN','return.manage'),
  ('ADMIN','rfq.read'),('ADMIN','rfq.manage'),('ADMIN','return.read'),('ADMIN','return.manage'),
  ('PROJECT_MANAGER','rfq.read'),('PROJECT_MANAGER','return.read'),('PROJECT_MANAGER','return.manage'),
  ('INVENTORY_MANAGER','rfq.read'),('INVENTORY_MANAGER','return.read'),('INVENTORY_MANAGER','return.manage'),
  ('TEAM_LEAD','rfq.read'),('TEAM_LEAD','return.read'),
  ('AUDITOR','rfq.read'),('AUDITOR','return.read'),
  ('BID_TENDER_MANAGER','rfq.read')
) AS g(role_code, code) ON g.role_code = r.code
ON CONFLICT DO NOTHING;
