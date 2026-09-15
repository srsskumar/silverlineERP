-- Client and Contact master (§6.5).
--
-- The deployed schema had no customer-side party at all: `vendors` covers who
-- we buy from, and nothing covered who we sell to. Leads, tenders, proposals,
-- projects and receivables all key off a client, so this table is the first
-- link in the §37 lifecycle chain and everything downstream references it.
--
-- Duplicate detection (§7.1, §51.3) runs on name/GSTIN/PAN/phone. GSTIN and PAN
-- are "highly sensitive" under §6.10 and the org may hold the same party twice
-- under different spellings, so the uniqueness that is safe to enforce in SQL
-- is on the tax identifiers; fuzzy name matching is advisory and surfaces in
-- the API as a warning rather than a constraint.

CREATE TABLE IF NOT EXISTS clients (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id),
  code               VARCHAR(50) NOT NULL,
  name               VARCHAR(255) NOT NULL,
  client_type        VARCHAR(20) NOT NULL DEFAULT 'PRIVATE',
  category           VARCHAR(100),
  -- Address hierarchy mirrors the geo columns already used by employees.
  state              VARCHAR(100),
  district           VARCHAR(100),
  mandal             VARCHAR(100),
  village            VARCHAR(100),
  address_line       TEXT,
  pincode            VARCHAR(12),
  website            VARCHAR(255),
  gstin              VARCHAR(20),
  pan                VARCHAR(15),
  credit_limit       NUMERIC(18,2),
  payment_terms      VARCHAR(100),
  blacklist_status   VARCHAR(20) NOT NULL DEFAULT 'NONE',
  blacklist_reason   TEXT,
  notes              TEXT,
  status             VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         UUID,
  CONSTRAINT chk_clients_type CHECK (client_type IN ('GOVERNMENT','PRIVATE')),
  CONSTRAINT chk_clients_status CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
  CONSTRAINT chk_clients_blacklist CHECK (blacklist_status IN ('NONE','WATCH','BLACKLISTED')),
  -- §3 "nothing is hard-deleted": a blacklisting must carry its reason.
  CONSTRAINT chk_clients_blacklist_reason
    CHECK (blacklist_status = 'NONE' OR blacklist_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_clients_code ON clients(org_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uk_clients_gstin
  ON clients(org_id, gstin) WHERE gstin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_clients_pan
  ON clients(org_id, pan) WHERE pan IS NOT NULL;
-- Drives the advisory duplicate check on create/import.
CREATE INDEX IF NOT EXISTS ix_clients_name_lower ON clients(org_id, lower(name));
CREATE INDEX IF NOT EXISTS ix_clients_status ON clients(org_id, status);

CREATE TABLE IF NOT EXISTS contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id),
  client_id           UUID REFERENCES clients(id),
  name                VARCHAR(255) NOT NULL,
  designation         VARCHAR(150),
  department          VARCHAR(150),
  phone               VARCHAR(20),
  alternate_phone     VARCHAR(20),
  email               VARCHAR(255),
  contact_type        VARCHAR(20) NOT NULL DEFAULT 'ADDITIONAL',
  address_line        TEXT,
  -- §7.4: excluded from any bulk outreach action.
  do_not_contact      BOOLEAN NOT NULL DEFAULT FALSE,
  notes               TEXT,
  status              VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID,
  CONSTRAINT chk_contacts_type CHECK (contact_type IN ('PRIMARY','ADDITIONAL')),
  CONSTRAINT chk_contacts_status CHECK (status IN ('ACTIVE','INACTIVE')),
  -- A contact with no way to reach them is a data-entry error, not a record.
  CONSTRAINT chk_contacts_reachable CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

-- §6.5 "one Primary + multiple Additional": at most one primary per client.
CREATE UNIQUE INDEX IF NOT EXISTS uk_contacts_primary
  ON contacts(client_id) WHERE contact_type = 'PRIMARY' AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_contacts_client ON contacts(org_id, client_id);
CREATE INDEX IF NOT EXISTS ix_contacts_phone ON contacts(org_id, phone) WHERE phone IS NOT NULL;

-- Vendor profile fields the tender spec adds on top of the baseline (§6.5).
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS vendor_type        VARCHAR(40),
  ADD COLUMN IF NOT EXISTS gstin              VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pan                VARCHAR(15),
  ADD COLUMN IF NOT EXISTS empanelment_status VARCHAR(20) NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS blacklist_status   VARCHAR(20) NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS blacklist_reason   TEXT,
  ADD COLUMN IF NOT EXISTS rating             NUMERIC(3,2);

CREATE UNIQUE INDEX IF NOT EXISTS uk_vendors_gstin
  ON vendors(org_id, gstin) WHERE gstin IS NOT NULL;

-- Employee fields the tender domain depends on (§6.1): billing_rate feeds
-- project costing, certifications feed tender eligibility evidence (§8.6).
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS billing_rate          NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS certifications        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS certification_expiry  DATE,
  ADD COLUMN IF NOT EXISTS experience_years      NUMERIC(4,1);
