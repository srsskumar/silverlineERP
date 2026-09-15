-- Indian government tender practice (§8).
--
-- §8.1 lists the fields generically. What it omits is how Indian public
-- tendering actually runs, and each omission below is something a bid team
-- tracks daily:
--
--  * Bids are quoted three different ways. An item-rate bid prices a BOQ line
--    by line; a percentage-rate bid quotes a single figure above or below the
--    estimated cost ("4.75% below ECV") and is the CPWD/PWD norm; a lump-sum
--    bid quotes one price. Storing only an absolute `bid_value` cannot
--    represent the second, which is the most common form in works tendering.
--  * Submission is almost always two-cover — a technical bid opened first,
--    and a financial bid opened only for firms that clear it. A tender sits in
--    "technically qualified, financial not yet opened" for weeks, and a single
--    status cannot say that.
--  * EMD and tender fee are different monies. The fee is non-refundable and
--    paid to buy the document; the EMD is refundable and blocks working
--    capital until it comes back. MSME/NSIC firms are usually exempt from EMD
--    and claim it by registration number.
--  * After opening, what matters is our L-rank. L1 wins.

ALTER TABLE tenders
  -- How the bid is priced.
  ADD COLUMN IF NOT EXISTS bid_type              VARCHAR(20) NOT NULL DEFAULT 'ITEM_RATE',
  -- For a percentage-rate bid: signed, negative meaning below the estimate.
  ADD COLUMN IF NOT EXISTS quoted_percentage     NUMERIC(6,3),
  -- Estimated Contract Value, the figure a percentage bid is applied to.
  ADD COLUMN IF NOT EXISTS ecv                   NUMERIC(18,2),

  -- Two-cover / three-cover submission.
  ADD COLUMN IF NOT EXISTS cover_system          VARCHAR(20) NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN IF NOT EXISTS technical_bid_opened_at DATE,
  ADD COLUMN IF NOT EXISTS technically_qualified BOOLEAN,
  ADD COLUMN IF NOT EXISTS technical_remarks     TEXT,
  ADD COLUMN IF NOT EXISTS financial_bid_opened_at DATE,

  -- Money in and money blocked.
  ADD COLUMN IF NOT EXISTS tender_fee            NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS tender_fee_paid_at    DATE,
  ADD COLUMN IF NOT EXISTS emd_amount            NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS emd_exempt            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS emd_exemption_basis   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS emd_exemption_ref     VARCHAR(50),

  -- Dates the generic model omits.
  ADD COLUMN IF NOT EXISTS pre_bid_meeting_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clarification_due_at  DATE,

  -- Outcome.
  ADD COLUMN IF NOT EXISTS our_rank              INTEGER,
  ADD COLUMN IF NOT EXISTS l1_amount             NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS work_order_no         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS work_order_date       DATE;

DO $$ BEGIN
  ALTER TABLE tenders ADD CONSTRAINT chk_tender_bid_type
    CHECK (bid_type IN ('ITEM_RATE','PERCENTAGE_RATE','LUMP_SUM'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE tenders ADD CONSTRAINT chk_tender_cover_system
    CHECK (cover_system IN ('SINGLE','TWO_COVER','THREE_COVER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A percentage-rate bid is meaningless without both the percentage and the
-- estimate it applies to.
DO $$ BEGIN
  ALTER TABLE tenders ADD CONSTRAINT chk_tender_percentage_bid
    CHECK (bid_type <> 'PERCENTAGE_RATE' OR quoted_percentage IS NULL OR ecv IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Quoting more than 100% below the estimate is arithmetic nonsense; the upper
-- bound catches a decimal-point slip on an above-estimate quote.
DO $$ BEGIN
  ALTER TABLE tenders ADD CONSTRAINT chk_tender_percentage_range
    CHECK (quoted_percentage IS NULL OR quoted_percentage BETWEEN -99.999 AND 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An exemption must name its basis and the registration that proves it,
-- because the authority asks for the number, not the claim.
DO $$ BEGIN
  ALTER TABLE tenders ADD CONSTRAINT chk_tender_emd_exemption
    CHECK (NOT emd_exempt OR (emd_exemption_basis IS NOT NULL AND emd_exemption_ref IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE tenders ADD CONSTRAINT chk_tender_emd_basis
    CHECK (emd_exemption_basis IS NULL OR emd_exemption_basis IN ('MSME','NSIC','STARTUP','OTHER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- L1 is the lowest; rank zero or negative is meaningless.
DO $$ BEGIN
  ALTER TABLE tenders ADD CONSTRAINT chk_tender_our_rank
    CHECK (our_rank IS NULL OR our_rank > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The financial cover cannot open before the technical one in a two-cover
-- tender; if it did, the qualification step was skipped.
DO $$ BEGIN
  ALTER TABLE tenders ADD CONSTRAINT chk_tender_cover_order
    CHECK (
      financial_bid_opened_at IS NULL
      OR technical_bid_opened_at IS NULL
      OR financial_bid_opened_at >= technical_bid_opened_at
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §8.4 reminder feed: what needs money or attention next.
CREATE INDEX IF NOT EXISTS ix_tenders_prebid
  ON tenders(org_id, pre_bid_meeting_at)
  WHERE pre_bid_meeting_at IS NOT NULL AND status NOT IN ('AWARDED','REJECTED','CANCELLED');

-- ------------------------------------------------------------- EMD refunds
--
-- EMD is the working capital a bid business actually worries about: it is paid
-- out on submission and comes back only after the tender concludes, and an
-- unclaimed refund is money sitting with a department. The instrument record
-- from 029 tracks the paper; this tracks the cash coming home.

ALTER TABLE bank_guarantee_instruments
  ADD COLUMN IF NOT EXISTS refund_due_date   DATE,
  ADD COLUMN IF NOT EXISTS refund_claimed_at DATE,
  ADD COLUMN IF NOT EXISTS refunded_at       DATE,
  ADD COLUMN IF NOT EXISTS refund_reference  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS forfeited_at      DATE,
  ADD COLUMN IF NOT EXISTS forfeiture_reason TEXT,
  -- On award, an EMD is commonly adjusted against the security deposit rather
  -- than refunded; the link records which instrument absorbed it.
  ADD COLUMN IF NOT EXISTS converted_to_id   UUID REFERENCES bank_guarantee_instruments(id);

DO $$ BEGIN
  ALTER TABLE bank_guarantee_instruments ADD CONSTRAINT chk_instrument_forfeiture
    CHECK (forfeited_at IS NULL OR forfeiture_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Money cannot both come back and be forfeited.
DO $$ BEGIN
  ALTER TABLE bank_guarantee_instruments ADD CONSTRAINT chk_instrument_refund_xor_forfeit
    CHECK (refunded_at IS NULL OR forfeited_at IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The outstanding-EMD report: paid, not yet back, not forfeited.
CREATE INDEX IF NOT EXISTS ix_instruments_awaiting_refund
  ON bank_guarantee_instruments(org_id, refund_due_date)
  WHERE instrument_status IN ('ACTIVE','RENEWED') AND refunded_at IS NULL AND forfeited_at IS NULL;
