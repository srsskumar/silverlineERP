-- The per-year debit actually posted for a leave request (R5 fix round 1,
-- item 3).
--
-- total_days is computed at filing, under the sandwich rule (D-012) using
-- whatever holidays exist that day. Approval can happen days or weeks
-- later, after a holiday was added or withdrawn in between -- so the debit
-- actually posted at approval can differ from the total_days stored at
-- filing. Recording the final per-year split the approval step actually
-- posts (and keeping total_days in sync with it) makes total_days one
-- source of truth for "how many days this cost", not two that can drift.
--
-- [{"year": 2027, "days": 3}, ...]. Empty until approved (nothing has been
-- debited yet); a year with 0 days after the sandwich rule is never listed
-- (fix round 1, item 1 -- an empty leave_balances row must not be created,
-- or treated as "open", for a year a request touches for zero days).
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS debited_days JSONB NOT NULL DEFAULT '[]';
