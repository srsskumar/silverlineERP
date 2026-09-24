-- Vendor-invoice lines keyed to the order, and an explicit MSME flag (task 5c,
-- finding B-004).
--
-- Three-way match already had a data model (migration 036's invoice_lines)
-- and a working route (procurement/routes.ts's /invoices/:id/match), but
-- nothing could write a line to it: no API route ever inserted into
-- invoice_lines, so the match route always ran against zero lines. The
-- matcher also paired lines by item_id, falling back to description -- fragile
-- when two lines share a description, and unable to say "this invoice line
-- was never on the order at all".
--
-- po_line_id closes both gaps: it lets a line say exactly which order line it
-- bills against (preferred over the item_id/description fallback), and its
-- absence on a line that also fails the fallback is what marks that line as
-- billed for something never ordered.

ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS po_line_id UUID REFERENCES purchase_order_lines(id);

CREATE INDEX IF NOT EXISTS ix_invoice_lines_po_line ON invoice_lines(po_line_id) WHERE po_line_id IS NOT NULL;

-- ---------------------------------------------------------------- MSME
--
-- Migration 032 added udyam_number and msme_category to vendors, and the
-- payables ageing already derives MSME status from their presence. What was
-- missing is the explicit registration flag itself -- without it there is no
-- way for a vendor to say "not MSME-registered" distinctly from "nobody has
-- entered the Udyam number yet", and no API route could write any of the
-- three fields regardless (vendorSchema in packages/shared/src/v2.ts never
-- carried them, so the generic vendor CRUD route silently dropped them).
--
-- Defaults true, not false: every row written before this column existed --
-- and every row a test or a script inserts directly, without going through
-- the (now updated) vendor API -- carries no opinion on the flag at all, and
-- the udyam+category derivation in packages/shared/src/ledgers.ts's
-- payableDue must keep reading exactly as it does today for every one of
-- them. Only an explicit false (a vendor whose registration has since
-- lapsed) turns statutory MSME treatment off; the ordinary case is that a
-- vendor with a category on file is registered, and the default says so.
--
-- Deliberately no CHECK tying this to msme_category being set. A vendor
-- whose registration has lapsed keeps its udyam_number and msme_category on
-- file -- that is the record of what it once was -- while msme_registered
-- alone says whether the statutory treatment in payableDue still applies.
-- Requiring the two to agree would make that state impossible to record.

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS msme_registered BOOLEAN NOT NULL DEFAULT TRUE;
