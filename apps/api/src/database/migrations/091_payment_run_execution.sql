-- Execute an approved payment run (§58.3.4, B-002).
--
-- An approved run had no further step: nothing recorded that the bank was
-- ever actually told to pay it, and no invoice on it was ever settled. This
-- adds the three facts execution needs to remember once the money has left
-- (when, and by which bank reference) and the two that say who did it and
-- when, so PAID means the same thing chk_run_approved already means for
-- APPROVED: the state and the person/time that produced it travel together.

ALTER TABLE payment_runs
  ADD COLUMN IF NOT EXISTS paid_on         DATE,
  ADD COLUMN IF NOT EXISTS bank_reference  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS execution_note  TEXT,
  ADD COLUMN IF NOT EXISTS executed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS executed_by     UUID REFERENCES users(id);

DO $$
BEGIN
  ALTER TABLE payment_runs ADD CONSTRAINT chk_run_paid
    CHECK (status <> 'PAID' OR (
      paid_on IS NOT NULL AND bank_reference IS NOT NULL
      AND executed_at IS NOT NULL AND executed_by IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
