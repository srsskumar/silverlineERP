-- PO amendment x auto-approval-sync (final QA fix wave, item 2).
--
-- reflectOnDocument (approvals/routes.ts) gives every purchase order the same
-- two outcomes: APPROVED when its ladder clears, DRAFT when it is rejected.
-- That is right for a fresh order's first approval, but an amendment that
-- re-routes a SENT or PARTIALLY_RECEIVED order through the ladder again must
-- land back where it was -- nothing about the vendor relationship or the
-- goods already received changed, only a line value did. Without this an
-- approved amendment silently un-ships the order (SENT -> APPROVED) and a
-- rejected one un-issues it (PARTIALLY_RECEIVED -> DRAFT).
--
-- Recorded on the amendment row rather than the order: an order has at most
-- one pending re-approval in flight, and the amendment that requested it is
-- exactly the row that knows what to restore. rejected_at flags a rejected
-- amendment rather than reverting the line changes it already made --
-- reversing quantities/rates against receipts already booked is its own
-- problem, out of scope here.

ALTER TABLE po_amendments ADD COLUMN IF NOT EXISTS pre_status VARCHAR(25);
ALTER TABLE po_amendments ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
