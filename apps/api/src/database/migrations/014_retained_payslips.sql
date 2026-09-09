-- Recalculation retains the identity and encrypted prior revisions of a slip.
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS payslip_revisions (
  payslip_id UUID NOT NULL REFERENCES payslips(id),
  version INTEGER NOT NULL,
  snapshot_encrypted TEXT NOT NULL,
  archived_by UUID NOT NULL REFERENCES users(id),
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payslip_id, version)
);
