-- Accounts payable and receivable (§58).
--
-- Neither ledger is stored. Both are derived from the documents and their
-- allocations, for the reason §45 gives: a cached balance and a ledger of
-- payments eventually disagree, and the ledger is always right.
--
-- What is stored is the small amount of state the ledgers need and cannot
-- derive — when goods were accepted (which starts the MSMED clock), whether a
-- payable is on hold, and when a receivable falls due.

ALTER TABLE invoices
  -- Starts the s.15 clock for an MSME supplier. Distinct from the invoice
  -- date: the Act counts from acceptance of the goods or service, which is
  -- what the goods receipt records.
  ADD COLUMN IF NOT EXISTS accepted_on    DATE,
  -- A held payable stays in the ageing and is kept out of the payment run.
  -- Hiding it would make the payables position look better than it is.
  ADD COLUMN IF NOT EXISTS on_hold        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_reason    TEXT;

DO $$
BEGIN
  ALTER TABLE invoices ADD CONSTRAINT chk_inv_hold
    CHECK (NOT on_hold OR hold_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A certified bill becomes a receivable on a date. Without one it is reported
-- as undated rather than assumed current — assuming makes an unknown look like
-- a good number.
ALTER TABLE ra_bills
  ADD COLUMN IF NOT EXISTS due_date DATE;

-- The RBI bank rate the s.16 interest is computed from. Held per organisation
-- because it changes, and a hard-coded rate silently produces a wrong
-- statutory liability after the next monetary policy review.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS rbi_bank_rate_pct NUMERIC(6,3) NOT NULL DEFAULT 6.5;

-- ------------------------------------------------------------ payment run

CREATE TABLE IF NOT EXISTS payment_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  run_no        VARCHAR(50) NOT NULL,
  run_date      DATE NOT NULL,
  due_through   DATE NOT NULL,
  bank_account  VARCHAR(50),
  status        VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  total_amount  NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes         TEXT,
  -- Approved by somebody other than whoever built it. Building a batch and
  -- releasing it single-handed is how money reaches an unintended account.
  approved_at   TIMESTAMPTZ,
  approved_by   UUID REFERENCES users(id),
  cancelled_reason TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  CONSTRAINT chk_run_status CHECK (status IN ('DRAFT','APPROVED','PAID','CANCELLED')),
  CONSTRAINT chk_run_approved CHECK (
    status NOT IN ('APPROVED','PAID') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  CONSTRAINT chk_run_cancelled CHECK (status <> 'CANCELLED' OR cancelled_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_run_no ON payment_runs(org_id, run_no);
CREATE INDEX IF NOT EXISTS ix_run_status ON payment_runs(org_id, status);

CREATE TABLE IF NOT EXISTS payment_run_lines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  run_id         UUID NOT NULL REFERENCES payment_runs(id) ON DELETE CASCADE,
  document_type  VARCHAR(20) NOT NULL,
  document_id    UUID NOT NULL,
  party_id       UUID,
  amount         NUMERIC(18,2) NOT NULL,
  -- Both dates are kept so a clerk can see why an invoice they thought had
  -- sixty days was paid first.
  contractual_due_date DATE,
  statutory_due_date   DATE,
  is_msme        BOOLEAN NOT NULL DEFAULT false,
  accrued_interest NUMERIC(18,2) NOT NULL DEFAULT 0,
  payment_id     UUID REFERENCES payments(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_run_line_amount CHECK (amount > 0),
  CONSTRAINT chk_run_line_doc CHECK (document_type IN ('VENDOR_INVOICE','EXPENSE_CLAIM'))
);

-- One document appears in a run once; twice would pay it twice.
CREATE UNIQUE INDEX IF NOT EXISTS uk_run_line ON payment_run_lines(run_id, document_type, document_id);
CREATE INDEX IF NOT EXISTS ix_run_line_doc ON payment_run_lines(document_type, document_id);
