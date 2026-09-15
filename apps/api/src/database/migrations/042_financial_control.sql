-- Financial control (§45).
--
-- Three structures and one rule.
--
-- **Payments and allocations are separate tables**, because §45.2 asks for one
-- payment against many invoices *and* many payments against one invoice. That
-- is a many-to-many, and a foreign key on either side cannot express it. The
-- unallocated balance — money in the bank nobody has matched yet — falls out
-- as a derived figure rather than being a status somebody has to maintain.
--
-- **Financial periods** carry who closed them and when. A boolean would say
-- that a month is closed without saying on whose authority, which is the one
-- question asked when a figure turns out to be wrong.
--
-- **Bank lines** hold a reconciliation state and the moment a person set it,
-- so an import can tell its own work from somebody's judgement.
--
-- The rule: nothing here is ever hard-deleted (§45.5). A financial record that
-- can vanish is a financial record that cannot be audited, so the way to undo
-- one is a reversal that leaves both entries standing.

-- ------------------------------------------------------ financial periods

CREATE TABLE IF NOT EXISTS financial_periods (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  code          VARCHAR(30) NOT NULL,
  starts_on     DATE NOT NULL,
  ends_on       DATE NOT NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'OPEN',
  closed_at     TIMESTAMPTZ,
  closed_by     UUID REFERENCES users(id),
  reopened_at   TIMESTAMPTZ,
  reopened_by   UUID REFERENCES users(id),
  reopen_reason TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  CONSTRAINT chk_fp_status CHECK (status IN ('OPEN','CLOSED')),
  CONSTRAINT chk_fp_range CHECK (ends_on >= starts_on),
  -- A close is only meaningful if it says who did it.
  CONSTRAINT chk_fp_closed CHECK (status <> 'CLOSED' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  -- Reopening moves figures somebody has already signed off.
  CONSTRAINT chk_fp_reopen CHECK (reopened_at IS NULL OR reopen_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_fp_code ON financial_periods(org_id, code);
-- Two periods covering one day would make "which period" a matter of luck.
CREATE INDEX IF NOT EXISTS ix_fp_range ON financial_periods(org_id, starts_on, ends_on);

-- ------------------------------------------------------------- payments

CREATE TABLE IF NOT EXISTS payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  payment_no    VARCHAR(50) NOT NULL,
  -- Money coming in against a receivable, or going out against a payable.
  direction     VARCHAR(12) NOT NULL,
  paid_on       DATE NOT NULL,
  amount        NUMERIC(18,2) NOT NULL,
  mode          VARCHAR(20) NOT NULL,
  reference     VARCHAR(100),
  party_type    VARCHAR(20),
  party_id      UUID,
  project_id    UUID REFERENCES projects(id),
  bank_account  VARCHAR(50),
  notes         TEXT,
  -- §45.5: never deleted. A reversal points back at what it undoes and both
  -- rows stay, so the ledger can always explain itself.
  reversed_at   TIMESTAMPTZ,
  reversed_by   UUID REFERENCES users(id),
  reversal_of   UUID REFERENCES payments(id),
  reversal_reason TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  CONSTRAINT chk_pay_direction CHECK (direction IN ('RECEIVABLE','PAYABLE')),
  CONSTRAINT chk_pay_amount CHECK (amount > 0),
  CONSTRAINT chk_pay_mode CHECK (mode IN
    ('NEFT','RTGS','IMPS','UPI','CHEQUE','DD','CASH','PAYROLL','ADJUSTMENT')),
  CONSTRAINT chk_pay_party CHECK (party_type IS NULL OR party_type IN ('CLIENT','VENDOR','EMPLOYEE')),
  CONSTRAINT chk_pay_reversal CHECK (reversed_at IS NULL OR reversal_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_pay_no ON payments(org_id, payment_no);
CREATE INDEX IF NOT EXISTS ix_pay_party ON payments(org_id, party_type, party_id);
CREATE INDEX IF NOT EXISTS ix_pay_date ON payments(org_id, paid_on DESC);
CREATE INDEX IF NOT EXISTS ix_pay_project ON payments(project_id);

-- --------------------------------------------------------- allocations

CREATE TABLE IF NOT EXISTS payment_allocations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  payment_id       UUID NOT NULL REFERENCES payments(id),
  document_type    VARCHAR(20) NOT NULL,
  document_id      UUID NOT NULL,
  -- Cash applied to the document.
  amount           NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- Tax the payer withheld and deposits on our behalf. This SETTLES the
  -- document: the money is ours, sitting with the government.
  tds_amount       NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- Money the payer keeps until the defect liability ends. This does NOT
  -- settle the document — it is still owed, only not collectable yet.
  retention_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  advance_adjusted NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_deduction  NUMERIC(18,2) NOT NULL DEFAULT 0,
  deduction_reason TEXT,
  reversed_at      TIMESTAMPTZ,
  reversal_of      UUID REFERENCES payment_allocations(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID,
  CONSTRAINT chk_alloc_document CHECK (document_type IN
    ('RA_BILL','VENDOR_INVOICE','EXPENSE_CLAIM','ADVANCE')),
  CONSTRAINT chk_alloc_nonneg CHECK (
    amount >= 0 AND tds_amount >= 0 AND retention_amount >= 0
    AND advance_adjusted >= 0 AND other_deduction >= 0),
  CONSTRAINT chk_alloc_something CHECK (
    amount + tds_amount + retention_amount + advance_adjusted + other_deduction > 0),
  -- A discretionary withholding is the line the client disputes, and an
  -- unexplained one cannot be defended.
  CONSTRAINT chk_alloc_reason CHECK (other_deduction = 0 OR deduction_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS ix_alloc_document ON payment_allocations(document_type, document_id);

-- ------------------------------------------------------ bank statement

CREATE TABLE IF NOT EXISTS bank_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  bank_account        VARCHAR(50),
  statement_ref       VARCHAR(100) NOT NULL,
  value_date          DATE NOT NULL,
  -- Signed: a credit is money in, a debit money out.
  amount              NUMERIC(18,2) NOT NULL,
  narration           TEXT,
  reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED',
  -- Set when a person confirms the match. An import must not overwrite a line
  -- that carries this; it raises an exception for them to look at instead.
  reconciled_at       TIMESTAMPTZ,
  reconciled_by       UUID REFERENCES users(id),
  payment_id          UUID REFERENCES payments(id),
  exception_note      TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID,
  CONSTRAINT chk_bt_status CHECK (reconciliation_status IN
    ('UNMATCHED','MATCHED','PARTIALLY_MATCHED','EXCEPTION','RECONCILED')),
  CONSTRAINT chk_bt_reconciled CHECK (
    reconciliation_status <> 'RECONCILED' OR (reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL))
);

-- A statement line arrives once. Re-importing the same file must update the
-- row rather than double it, or the bank balance doubles with it.
CREATE UNIQUE INDEX IF NOT EXISTS uk_bt_ref
  ON bank_transactions(org_id, COALESCE(bank_account, ''), statement_ref);
CREATE INDEX IF NOT EXISTS ix_bt_status ON bank_transactions(org_id, reconciliation_status);
CREATE INDEX IF NOT EXISTS ix_bt_date ON bank_transactions(org_id, value_date DESC);

-- --------------------------------------------- invoice lifecycle (§45.1)

ALTER TABLE invoices
  -- Separate from match_status, which answers a different question: whether
  -- the bill agrees with the order and the receipt.
  ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'ISSUED',
  ADD COLUMN IF NOT EXISTS due_date         DATE,
  -- A flag rather than a status, because the invoice a client disputes is
  -- exactly the one that also goes overdue, and a single enum cannot say both.
  ADD COLUMN IF NOT EXISTS disputed         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dispute_reason   TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;

DO $$
BEGIN
  ALTER TABLE invoices ADD CONSTRAINT chk_inv_lifecycle
    CHECK (lifecycle_status IN ('DRAFT','SUBMITTED','APPROVED','ISSUED','CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE invoices ADD CONSTRAINT chk_inv_dispute
    CHECK (NOT disputed OR dispute_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ix_inv_lifecycle ON invoices(org_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS ix_inv_due ON invoices(org_id, due_date) WHERE due_date IS NOT NULL;

-- ------------------------------------------ one payment-mode list (§15.4)

-- Payment instruments are now a single shared list: a client receipt and an
-- employee reimbursement move money the same ways, and two lists drift until a
-- mode valid on one screen is refused by another. Widening the reimbursement
-- constraint to match keeps the schema and the database saying the same thing.
DO $$
BEGIN
  ALTER TABLE expense_reimbursements DROP CONSTRAINT chk_exp_reimb_mode;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE expense_reimbursements
  ADD CONSTRAINT chk_exp_reimb_mode CHECK (mode IN
    ('NEFT','RTGS','IMPS','UPI','CHEQUE','DD','CASH','PAYROLL','ADJUSTMENT'));
