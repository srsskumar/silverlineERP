-- One invoice, one open payment run (§58.3.4).
--
-- 046 stopped a document appearing twice in the same run, and nothing
-- stopped it appearing in two. Two runs built a day apart each picked up
-- every unpaid invoice, both were approved, and the bank was asked to pay the
-- same supplier the same amount twice. The API now refuses that; this is the
-- database refusing it as well, so a second writer or a future code path
-- cannot quietly undo the check.
--
-- A unique index cannot look at another table, so each line carries whether
-- its run is still open. A trigger on payment_runs keeps it in step: a
-- cancelled run lets its invoices go back into the pool, and so does a paid
-- one, where whatever is still outstanding has to be payable by a later run.

ALTER TABLE payment_run_lines
  ADD COLUMN IF NOT EXISTS run_open BOOLEAN NOT NULL DEFAULT true,
  -- Why an invoice whose three-way match failed was paid anyway. Kept on the
  -- line, next to the amount it released, because that is where an auditor
  -- asking "why was this paid" will look.
  ADD COLUMN IF NOT EXISTS match_override_reason TEXT;

-- Idempotent: recomputed from the run, so re-running changes nothing.
UPDATE payment_run_lines l
   SET run_open = (r.status IN ('DRAFT','APPROVED'))
  FROM payment_runs r
 WHERE r.id = l.run_id
   AND l.run_open IS DISTINCT FROM (r.status IN ('DRAFT','APPROVED'));

CREATE OR REPLACE FUNCTION payment_run_lines_follow_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE payment_run_lines
       SET run_open = (NEW.status IN ('DRAFT','APPROVED'))
     WHERE run_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_run_lines_follow_run ON payment_runs;
CREATE TRIGGER trg_payment_run_lines_follow_run
  AFTER UPDATE OF status ON payment_runs
  FOR EACH ROW EXECUTE FUNCTION payment_run_lines_follow_run();

-- A live database may already hold the double booking this prevents. The
-- index cannot be built over it, and refusing to deploy over it helps nobody,
-- so where one document sits on several open runs only the earliest keeps the
-- claim. Nothing else about the later runs changes -- they stay DRAFT or
-- APPROVED with every line -- and the API, which checks run status rather than
-- this flag, refuses to approve them while the earlier run holds the invoice.
-- Idempotent: once each document has one open line, this matches nothing.
UPDATE payment_run_lines l
   SET run_open = false
  FROM (
    SELECT l2.id,
           row_number() OVER (PARTITION BY l2.document_type, l2.document_id
                              ORDER BY r.created_at, r.id) AS claim
      FROM payment_run_lines l2
      JOIN payment_runs r ON r.id = l2.run_id
     WHERE l2.run_open
  ) ranked
 WHERE ranked.id = l.id AND ranked.claim > 1;

-- The guard itself.
CREATE UNIQUE INDEX IF NOT EXISTS uk_run_line_open_document
  ON payment_run_lines(document_type, document_id) WHERE run_open;
