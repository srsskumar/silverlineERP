-- India statutory master data (§6.5, §6.10, §15).
--
-- Corrects a modelling error in 027. A party has ONE PAN — it identifies the
-- legal entity — but ONE GSTIN PER STATE it operates in. A contractor working
-- in Maharashtra, Karnataka and Telangana holds three GSTINs sharing a PAN,
-- and which one appears on an invoice depends on the place of supply. A single
-- `clients.gstin` column cannot express that, and every GST invoice, e-way
-- bill and GSTR return depends on getting it right.
--
-- Expand-and-contract: the registrations table arrives and is backfilled here,
-- the API stops writing the old column in the same release, and a later
-- migration drops it. Dropping it now would 500 the currently deployed build
-- for the length of the deploy.

CREATE TABLE IF NOT EXISTS party_gst_registrations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  -- Polymorphic: the same legal entity is often both customer and supplier,
  -- and its registrations are the same either way.
  party_type          VARCHAR(20) NOT NULL,
  party_id            UUID NOT NULL,
  gstin               VARCHAR(15) NOT NULL,
  -- Derived from the GSTIN's first two digits and stored so that queries can
  -- filter by state without re-parsing every row.
  state_code          VARCHAR(2) NOT NULL,
  registration_type   VARCHAR(20) NOT NULL DEFAULT 'REGULAR',
  -- The address this registration is held at; drives place of supply.
  address_line        TEXT,
  is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from      DATE,
  effective_to        DATE,
  status              VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID,
  CONSTRAINT chk_pgr_party CHECK (party_type IN ('CLIENT','VENDOR')),
  -- §6.10: registration type changes the tax treatment entirely. A composition
  -- dealer charges no GST; an SEZ supply is zero-rated; an unregistered party
  -- may trigger reverse charge.
  CONSTRAINT chk_pgr_reg_type CHECK (registration_type IN
    ('REGULAR','COMPOSITION','UNREGISTERED','SEZ','SEZ_DEVELOPER','UIN','NON_RESIDENT')),
  CONSTRAINT chk_pgr_status CHECK (status IN ('ACTIVE','SUSPENDED','CANCELLED')),
  CONSTRAINT chk_pgr_dates CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  -- Structure only; the check digit is verified in application code because
  -- SQL cannot express the GSTN algorithm readably.
  CONSTRAINT chk_pgr_gstin_shape CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  CONSTRAINT chk_pgr_state_matches CHECK (left(gstin, 2) = state_code)
);

-- A GSTIN is unique nationally, so two parties cannot share one.
CREATE UNIQUE INDEX IF NOT EXISTS uk_pgr_gstin ON party_gst_registrations(org_id, gstin);
-- One live registration per party per state: a second is a data error, not a
-- second place of business.
CREATE UNIQUE INDEX IF NOT EXISTS uk_pgr_party_state
  ON party_gst_registrations(party_type, party_id, state_code) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uk_pgr_primary
  ON party_gst_registrations(party_type, party_id) WHERE is_primary AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_pgr_party ON party_gst_registrations(party_type, party_id);

-- Carry across whatever the single-column model captured.
INSERT INTO party_gst_registrations (org_id, party_type, party_id, gstin, state_code, is_primary)
SELECT org_id, 'CLIENT', id, upper(gstin), left(upper(gstin), 2), TRUE
FROM clients
WHERE gstin IS NOT NULL AND upper(gstin) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
ON CONFLICT DO NOTHING;

INSERT INTO party_gst_registrations (org_id, party_type, party_id, gstin, state_code, is_primary)
SELECT org_id, 'VENDOR', id, upper(gstin), left(upper(gstin), 2), TRUE
FROM vendors
WHERE gstin IS NOT NULL AND upper(gstin) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- MSME
--
-- MSMED Act 2006 s.15 fixes the payment window by statute — 45 days with a
-- written agreement, 15 without — and s.16 makes interest automatic on breach.
-- The Act overrides a longer contractual term, so a system that honours only
-- `payment_terms` under-reports the liability. Registration status is also
-- what exempts a bidder from EMD in most government tenders.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS udyam_number     VARCHAR(25),
  ADD COLUMN IF NOT EXISTS msme_category    VARCHAR(10),
  ADD COLUMN IF NOT EXISTS has_written_agreement BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS udyam_number     VARCHAR(25),
  ADD COLUMN IF NOT EXISTS msme_category    VARCHAR(10),
  ADD COLUMN IF NOT EXISTS has_written_agreement BOOLEAN NOT NULL DEFAULT TRUE,
  -- TDS treatment travels with the payee, not the payment.
  ADD COLUMN IF NOT EXISTS tds_section              VARCHAR(20),
  ADD COLUMN IF NOT EXISTS lower_deduction_rate_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS lower_deduction_cert_no  VARCHAR(50),
  ADD COLUMN IF NOT EXISTS lower_deduction_valid_to DATE;

DO $$
BEGIN
  ALTER TABLE clients ADD CONSTRAINT chk_clients_msme
    CHECK (msme_category IS NULL OR msme_category IN ('MICRO','SMALL','MEDIUM'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE vendors ADD CONSTRAINT chk_vendors_msme
    CHECK (msme_category IS NULL OR msme_category IN ('MICRO','SMALL','MEDIUM'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A lower-deduction certificate without its rate and expiry cannot be applied,
-- and applying an expired one is a deduction default (§20.3 audit).
DO $$
BEGIN
  ALTER TABLE vendors ADD CONSTRAINT chk_vendors_lower_deduction
    CHECK (
      lower_deduction_cert_no IS NULL
      OR (lower_deduction_rate_pct IS NOT NULL AND lower_deduction_valid_to IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- An MSME claim needs its Udyam number; the number is the evidence.
DO $$
BEGIN
  ALTER TABLE vendors ADD CONSTRAINT chk_vendors_udyam
    CHECK (msme_category IS NULL OR udyam_number IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ix_vendors_msme ON vendors(org_id) WHERE msme_category IS NOT NULL;

-- ------------------------------------------------- supplier's own identity
--
-- Every GST computation needs the supplier's state to decide CGST+SGST versus
-- IGST. The organization had no statutory identity at all.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS pan               VARCHAR(10),
  ADD COLUMN IF NOT EXISTS primary_gstin     VARCHAR(15),
  ADD COLUMN IF NOT EXISTS primary_state_code VARCHAR(2),
  ADD COLUMN IF NOT EXISTS cin               VARCHAR(21),
  ADD COLUMN IF NOT EXISTS tan               VARCHAR(10),
  -- MSMED s.16 interest is three times this; the RBI revises it, so it is
  -- configuration rather than a constant in code.
  ADD COLUMN IF NOT EXISTS rbi_bank_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 6.50;

DO $$
BEGIN
  ALTER TABLE organizations ADD CONSTRAINT chk_org_state_matches_gstin
    CHECK (primary_gstin IS NULL OR primary_state_code IS NULL OR left(primary_gstin, 2) = primary_state_code);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
