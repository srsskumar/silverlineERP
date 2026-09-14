-- Tender and bid management (§6.4, §8).
--
-- Tender status and the linked project's status are deliberately independent
-- (§8.3): a tender may be Selected while its project has not started, or does
-- not exist yet. Nothing here derives one from the other.

CREATE TABLE IF NOT EXISTS tenders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  tender_no           VARCHAR(50) NOT NULL,
  tender_type         VARCHAR(20) NOT NULL,
  category            VARCHAR(150),
  client_id           UUID REFERENCES clients(id),
  opportunity_id      UUID REFERENCES opportunities(id),
  -- §8.1 government identifiers
  state               VARCHAR(100),
  district            VARCHAR(100),
  location            VARCHAR(255),
  department          VARCHAR(255),
  authority           VARCHAR(255),
  reference_number    VARCHAR(100),
  package_lot_no      VARCHAR(50),
  estimated_value     NUMERIC(18,2),
  bid_value           NUMERIC(18,2),
  -- §8.4 tracked dates; reminders key off these and must follow a corrigendum.
  start_date          DATE,
  closing_date        DATE,
  opening_date        DATE,
  submission_date     DATE,
  bid_validity_days   INTEGER,
  portal              VARCHAR(150),
  portal_url          TEXT,
  dsc_used_by         UUID REFERENCES employees(id),
  jv_flag             BOOLEAN NOT NULL DEFAULT FALSE,
  jv_partners         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status              VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  -- §8.6 override trail: set only when an authorised user pushes past an
  -- incomplete eligibility checklist, and never silently.
  eligibility_override_by     UUID REFERENCES users(id),
  eligibility_override_reason TEXT,
  eligibility_override_at     TIMESTAMPTZ,
  notes               TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID,
  CONSTRAINT chk_tender_type CHECK (tender_type IN ('OPEN','LIMITED','SINGLE','EOI','RFP')),
  -- §8.2 default status machine.
  CONSTRAINT chk_tender_status CHECK (status IN
    ('DRAFT','PUBLISHED','IN_PROGRESS','SUBMITTED','UNDER_EVALUATION',
     'CLARIFICATION_REQUIRED','SELECTED','REJECTED','AWARDED','CANCELLED')),
  CONSTRAINT chk_tender_dates CHECK (closing_date IS NULL OR start_date IS NULL OR closing_date >= start_date),
  CONSTRAINT chk_tender_override_complete CHECK (
    (eligibility_override_by IS NULL AND eligibility_override_reason IS NULL AND eligibility_override_at IS NULL)
    OR (eligibility_override_by IS NOT NULL AND eligibility_override_reason IS NOT NULL AND eligibility_override_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_tenders_no ON tenders(org_id, tender_no);
CREATE INDEX IF NOT EXISTS ix_tenders_status ON tenders(org_id, status);
CREATE INDEX IF NOT EXISTS ix_tenders_closing
  ON tenders(org_id, closing_date) WHERE status NOT IN ('AWARDED','REJECTED','CANCELLED');
CREATE INDEX IF NOT EXISTS ix_tenders_client ON tenders(org_id, client_id);

-- §8.5 A corrigendum that shifts a tracked date must retain the prior value in
-- history rather than silently overwriting it, so the prior/new pair is stored
-- on the corrigendum itself — the tender row holds only the current value.
CREATE TABLE IF NOT EXISTS tender_corrigenda (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id),
  tender_id          UUID NOT NULL REFERENCES tenders(id),
  corrigendum_no     VARCHAR(50) NOT NULL,
  date_issued        DATE NOT NULL,
  summary            TEXT NOT NULL,
  fields_affected    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{field, previous_value, new_value}] captured at the moment of application.
  prior_values       JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at         TIMESTAMPTZ,
  applied_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_corrigenda_no
  ON tender_corrigenda(tender_id, corrigendum_no);
CREATE INDEX IF NOT EXISTS ix_corrigenda_tender
  ON tender_corrigenda(tender_id, date_issued DESC);

-- §8.6 pre-qualification / eligibility checklist.
CREATE TABLE IF NOT EXISTS tender_eligibility_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  tender_id         UUID NOT NULL REFERENCES tenders(id),
  requirement_name  VARCHAR(255) NOT NULL,
  is_required       BOOLEAN NOT NULL DEFAULT TRUE,
  item_status       VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED',
  document_id       UUID,
  notes             TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID,
  CONSTRAINT chk_eligibility_status CHECK (item_status IN
    ('NOT_STARTED','IN_PROGRESS','READY','SUBMITTED'))
);

CREATE INDEX IF NOT EXISTS ix_eligibility_tender ON tender_eligibility_items(tender_id);
-- The gate in §8.11/§8.6 asks one question repeatedly: are any required items
-- outstanding? This index answers it without scanning the whole checklist.
CREATE INDEX IF NOT EXISTS ix_eligibility_outstanding
  ON tender_eligibility_items(tender_id)
  WHERE is_required AND item_status NOT IN ('READY','SUBMITTED');

-- §8.9 optional competitor record; feeds win/loss analytics.
CREATE TABLE IF NOT EXISTS competitor_bids (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  tender_id       UUID NOT NULL REFERENCES tenders(id),
  competitor_name VARCHAR(255) NOT NULL,
  quoted_amount   NUMERIC(18,2),
  rank            INTEGER,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID,
  CONSTRAINT chk_competitor_rank CHECK (rank IS NULL OR rank > 0)
);

CREATE INDEX IF NOT EXISTS ix_competitor_tender ON competitor_bids(tender_id, rank);

-- §6.4 / §8.10 / §15.5 financial instruments. Each tender or project can hold
-- several, tracked individually with expiry alerts, rather than as flat fields.
CREATE TABLE IF NOT EXISTS bank_guarantee_instruments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id),
  instrument_type    VARCHAR(30) NOT NULL,
  issuing_bank       VARCHAR(255) NOT NULL,
  instrument_number  VARCHAR(100) NOT NULL,
  amount             NUMERIC(18,2) NOT NULL,
  issue_date         DATE NOT NULL,
  expiry_date        DATE NOT NULL,
  instrument_status  VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  tender_id          UUID REFERENCES tenders(id),
  project_id         UUID REFERENCES projects(id),
  document_id        UUID,
  notes              TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         UUID,
  CONSTRAINT chk_instrument_type CHECK (instrument_type IN
    ('EMD','BID_SECURITY_BG','PERFORMANCE_BG','ADVANCE_BG','RETENTION_BG')),
  CONSTRAINT chk_instrument_status CHECK (instrument_status IN
    ('ACTIVE','RELEASED','CLAIMED','EXPIRED','RENEWED')),
  -- §6.4: expiry cannot precede issue date.
  CONSTRAINT chk_instrument_dates CHECK (expiry_date >= issue_date),
  -- An instrument must secure something.
  CONSTRAINT chk_instrument_subject CHECK (tender_id IS NOT NULL OR project_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_instrument_number
  ON bank_guarantee_instruments(org_id, instrument_number);
CREATE INDEX IF NOT EXISTS ix_instrument_tender  ON bank_guarantee_instruments(tender_id);
CREATE INDEX IF NOT EXISTS ix_instrument_project ON bank_guarantee_instruments(project_id);
-- §8.4/§22.2 expiry reminders scan live instruments by date.
CREATE INDEX IF NOT EXISTS ix_instrument_expiry
  ON bank_guarantee_instruments(org_id, expiry_date)
  WHERE instrument_status IN ('ACTIVE','RENEWED');

-- §8.8 private-track equivalent of a tender. Government-specific fields stay on
-- `tenders`; this record carries the quotation/negotiation vocabulary instead.
CREATE TABLE IF NOT EXISTS private_proposals (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id),
  proposal_no             VARCHAR(50) NOT NULL,
  client_id               UUID NOT NULL REFERENCES clients(id),
  contact_id              UUID REFERENCES contacts(id),
  opportunity_id          UUID REFERENCES opportunities(id),
  rfq_reference           VARCHAR(100),
  proposal_date           DATE NOT NULL,
  quotation_no            VARCHAR(50),
  quotation_date          DATE,
  contract_value          NUMERIC(18,2),
  negotiation_status      VARCHAR(30),
  competing_quotes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  recurring_amc_flag      BOOLEAN NOT NULL DEFAULT FALSE,
  proposal_status         VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  notes                   TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              UUID,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              UUID,
  CONSTRAINT chk_proposal_status CHECK (proposal_status IN
    ('DRAFT','SENT','UNDER_NEGOTIATION','ACCEPTED','REJECTED','WITHDRAWN'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_proposals_no ON private_proposals(org_id, proposal_no);
CREATE INDEX IF NOT EXISTS ix_proposals_status ON private_proposals(org_id, proposal_status);
CREATE INDEX IF NOT EXISTS ix_proposals_client ON private_proposals(org_id, client_id);
