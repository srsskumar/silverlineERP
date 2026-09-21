-- When a certified RA bill falls due, and whether the client disputes it (§58.2).
--
-- 046 gave ra_bills a due_date and nothing ever wrote it, so every receivable
-- was reported as undated and the receivables ageing showed nothing overdue,
-- ever -- the one number the report exists to produce. The date comes from
-- the payment terms agreed on the project, counted from certification.
--
-- The terms are nullable with no default on purpose. A project whose terms
-- nobody has recorded stays undated, as it is now: inventing thirty days
-- would make an unknown look like a good number, which is the failure the
-- undated column is there to prevent.

ALTER TABLE project_billing_policies
  ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER;

DO $$
BEGIN
  ALTER TABLE project_billing_policies ADD CONSTRAINT chk_pbp_terms
    CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Bills already certified under recorded terms get the date they would have
-- had. Counted from the certification day where the organisation works, not
-- in UTC. Idempotent: only bills with no due date are touched, so a re-run,
-- or a date somebody has since corrected by hand, is left alone.
UPDATE ra_bills b
   SET due_date = (b.certified_at AT TIME ZONE COALESCE(o.settings->>'timezone', 'Asia/Kolkata'))::date
                  + p.payment_terms_days
  FROM project_billing_policies p, organizations o
 WHERE p.project_id = b.project_id
   AND o.id = b.org_id
   AND b.status IN ('CERTIFIED','PAID')
   AND b.due_date IS NULL
   AND b.certified_at IS NOT NULL
   AND p.payment_terms_days IS NOT NULL;

-- A disputed receivable is a different problem from a slow one and goes to a
-- different person. A flag rather than a status, as on invoices: the bill a
-- client disputes is exactly the one that also goes overdue, and both facts
-- have to be visible.
ALTER TABLE ra_bills
  ADD COLUMN IF NOT EXISTS disputed       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dispute_reason TEXT;

DO $$
BEGIN
  ALTER TABLE ra_bills ADD CONSTRAINT chk_ra_dispute_reason
    CHECK (NOT disputed OR dispute_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
