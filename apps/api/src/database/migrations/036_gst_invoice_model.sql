-- A GST-compliant invoice model (§15, §6.10).
--
-- The existing `invoices` table carries gst_enabled, gst_rate and a single
-- `tax` column. That cannot produce a compliant invoice or feed a GSTR return,
-- for three reasons:
--
--  1. Tax splits into CGST+SGST or IGST depending on place of supply against
--     the supplier's state. One `tax` column cannot say which, and the return
--     needs the split, not the total.
--  2. Rate is per line, not per invoice. Cement at 28% and sand at 5% on one
--     invoice is ordinary, and a single gst_rate silently misstates both.
--  3. HSN/SAC is per line too, and HSN-wise summary is a required annexure.
--
-- Existing columns are kept and backfilled rather than replaced: 52 invoices
-- are live, three modules read them, and a rename would break all of it for
-- the length of a deploy.

ALTER TABLE invoices
  -- The statutory document date, distinct from when the row was created.
  ADD COLUMN IF NOT EXISTS invoice_date       DATE,
  ADD COLUMN IF NOT EXISTS supplier_gstin     VARCHAR(15),
  ADD COLUMN IF NOT EXISTS recipient_gstin    VARCHAR(15),
  -- Two-digit state code. Decides CGST+SGST versus IGST, and it is the place
  -- the supply is made — not the billing address, which is a different thing
  -- when work is performed at a site in another state.
  ADD COLUMN IF NOT EXISTS place_of_supply    VARCHAR(2),
  -- s.9(3)/9(4): the recipient pays the tax directly, so the supplier charges
  -- none and the liability sits on our side.
  ADD COLUMN IF NOT EXISTS reverse_charge     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS taxable_value      NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS cgst_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cess_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS round_off          NUMERIC(6,2) NOT NULL DEFAULT 0,
  -- Financial year the serial belongs to. Rule 46(b) requires the series to be
  -- unique within the year, which a calendar year does not satisfy.
  ADD COLUMN IF NOT EXISTS financial_year     VARCHAR(7),
  ADD COLUMN IF NOT EXISTS gst_treatment      VARCHAR(20);

DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT chk_inv_treatment
    CHECK (gst_treatment IS NULL OR gst_treatment IN
      ('INTRA_STATE','INTER_STATE','EXPORT','SEZ','EXEMPT','NIL_RATED','NON_GST'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CGST and SGST always move together and never alongside IGST. A row carrying
-- both is arithmetically impossible and would fail the return.
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT chk_inv_gst_exclusive
    CHECK (
      (igst_amount = 0) OR (cgst_amount = 0 AND sgst_amount = 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT chk_inv_cgst_sgst_paired
    CHECK ((cgst_amount = 0) = (sgst_amount = 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reverse charge means the supplier charges no tax; carrying an amount would
-- double-count the liability.
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT chk_inv_reverse_charge
    CHECK (NOT reverse_charge OR (cgst_amount = 0 AND sgst_amount = 0 AND igst_amount = 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Rule 46(b): the serial is unique within the financial year, not for all time.
CREATE UNIQUE INDEX IF NOT EXISTS uk_invoices_serial_fy
  ON invoices(org_id, financial_year, serial_number) WHERE financial_year IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_invoices_date ON invoices(org_id, invoice_date);
CREATE INDEX IF NOT EXISTS ix_invoices_pos ON invoices(org_id, place_of_supply);

-- Backfill what can be derived. Existing rows predate the split, so their tax
-- is recorded as intra-state — the common case — and flagged for review rather
-- than guessed at silently.
UPDATE invoices
SET invoice_date  = COALESCE(invoice_date, created_at::date),
    taxable_value = COALESCE(taxable_value, subtotal),
    gst_treatment = COALESCE(gst_treatment, CASE WHEN COALESCE(tax,0) > 0 THEN 'INTRA_STATE' ELSE 'EXEMPT' END),
    cgst_amount   = CASE WHEN cgst_amount = 0 AND COALESCE(tax,0) > 0 THEN round(tax/2, 2) ELSE cgst_amount END,
    sgst_amount   = CASE WHEN sgst_amount = 0 AND COALESCE(tax,0) > 0 THEN tax - round(tax/2, 2) ELSE sgst_amount END
WHERE invoice_date IS NULL OR taxable_value IS NULL;

-- Financial year from the invoice date: April to March.
UPDATE invoices
SET financial_year = CASE
      WHEN extract(month FROM invoice_date) >= 4
        THEN extract(year FROM invoice_date)::text || '-' || lpad(((extract(year FROM invoice_date)::int + 1) % 100)::text, 2, '0')
      ELSE (extract(year FROM invoice_date)::int - 1)::text || '-' || lpad((extract(year FROM invoice_date)::int % 100)::text, 2, '0')
    END
WHERE financial_year IS NULL AND invoice_date IS NOT NULL;

-- ------------------------------------------------------------ line items
--
-- Rate and HSN belong on the line. Cement at 28% beside sand at 5% on one
-- invoice is ordinary, and the HSN-wise summary is a required annexure.

CREATE TABLE IF NOT EXISTS invoice_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  item_id         UUID REFERENCES inventory_items(id),
  description     TEXT NOT NULL,
  -- HSN for goods, SAC for services; the same field, different code list.
  hsn_sac         VARCHAR(10) NOT NULL,
  unit            VARCHAR(20),
  quantity        NUMERIC(16,3) NOT NULL DEFAULT 1,
  unit_rate       NUMERIC(16,4) NOT NULL,
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  taxable_value   NUMERIC(18,2) NOT NULL,
  gst_rate_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
  cgst_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  sgst_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  igst_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  cess_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total      NUMERIC(18,2) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_il_quantity CHECK (quantity > 0),
  CONSTRAINT chk_il_taxable CHECK (taxable_value >= 0),
  -- The HSN chapter heading is 4 digits; 6 and 8 add sub-headings. Anything
  -- shorter cannot be reported, and the annexure is rejected.
  CONSTRAINT chk_il_hsn CHECK (hsn_sac ~ '^[0-9]{4,8}$'),
  -- The notified GST rates. A rate outside this set is a data-entry error.
  CONSTRAINT chk_il_rate CHECK (gst_rate_pct IN (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28)),
  CONSTRAINT chk_il_gst_exclusive CHECK ((igst_amount = 0) OR (cgst_amount = 0 AND sgst_amount = 0)),
  CONSTRAINT chk_il_cgst_sgst_paired CHECK ((cgst_amount = 0) = (sgst_amount = 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_invoice_line_no ON invoice_lines(invoice_id, line_no);
CREATE INDEX IF NOT EXISTS ix_invoice_lines_invoice ON invoice_lines(invoice_id);
-- The HSN-wise summary annexure groups by code and rate.
CREATE INDEX IF NOT EXISTS ix_invoice_lines_hsn ON invoice_lines(org_id, hsn_sac, gst_rate_pct);
