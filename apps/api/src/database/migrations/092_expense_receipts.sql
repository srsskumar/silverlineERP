-- Expense receipt attachments (§16, B-003).
--
-- A claimant's supporting bills, one row per file, stored the same way
-- employee_documents and task_evidence already are: content encrypted in the
-- row rather than on a local disk, because the API runs on a host whose
-- filesystem does not survive between requests (see migration 026's note).
-- No FK-checked polymorphic owner is needed here — a receipt only ever
-- belongs to one expense claim.

CREATE TABLE IF NOT EXISTS expense_receipts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  claim_id          UUID NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  file_name         VARCHAR(255) NOT NULL,
  content_encrypted TEXT NOT NULL,
  file_size         INTEGER NOT NULL,
  mime_type         VARCHAR(100),
  checksum          VARCHAR(64) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_expense_receipts_claim
  ON expense_receipts(claim_id, created_at DESC, id DESC);
