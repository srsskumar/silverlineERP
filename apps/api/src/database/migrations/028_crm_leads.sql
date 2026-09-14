-- CRM: leads, opportunities and the interaction timeline (§6.3, §7).
--
-- The pipeline starts before a tender exists. Without these tables §18.1 win-
-- rate analysis is blind to everything that never became a tender, which is the
-- explicit rationale given in §7.

CREATE TABLE IF NOT EXISTS leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id),
  lead_no               VARCHAR(50) NOT NULL,
  source                VARCHAR(30) NOT NULL,
  organization_name     VARCHAR(255) NOT NULL,
  -- Nullable: a lead may be logged before the party exists in the master, and
  -- is linked on qualification rather than duplicated (§7.1, §37.2).
  client_id             UUID REFERENCES clients(id),
  contact_id            UUID REFERENCES contacts(id),
  lead_type             VARCHAR(20) NOT NULL,
  estimated_value       NUMERIC(18,2),
  stage                 VARCHAR(30) NOT NULL DEFAULT 'NEW',
  owner_id              UUID REFERENCES users(id),
  next_follow_up_date   DATE,
  -- Set when the stage machine reaches a terminal state; §7.3 keeps the record
  -- and its history rather than deleting it.
  lost_reason           TEXT,
  notes                 TEXT,
  status                VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID,
  CONSTRAINT chk_leads_type CHECK (lead_type IN ('GOVERNMENT','PRIVATE')),
  CONSTRAINT chk_leads_source CHECK (source IN
    ('REFERRAL','PORTAL_WATCH','COLD_OUTREACH','EXISTING_CLIENT','OTHER')),
  -- §7.2 default stage machine.
  CONSTRAINT chk_leads_stage CHECK (stage IN
    ('NEW','CONTACTED','QUALIFIED','TENDER_IDENTIFIED','CONVERTED','LOST','DISQUALIFIED')),
  CONSTRAINT chk_leads_status CHECK (status IN ('OPEN','CLOSED')),
  -- A lead that ended badly must say why; pipeline analysis (§7.5) depends on it.
  CONSTRAINT chk_leads_lost_reason
    CHECK (stage NOT IN ('LOST','DISQUALIFIED') OR lost_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_leads_no ON leads(org_id, lead_no);
CREATE INDEX IF NOT EXISTS ix_leads_stage ON leads(org_id, stage);
CREATE INDEX IF NOT EXISTS ix_leads_owner ON leads(org_id, owner_id);
CREATE INDEX IF NOT EXISTS ix_leads_follow_up
  ON leads(org_id, next_follow_up_date) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS opportunities (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id),
  lead_id               UUID NOT NULL REFERENCES leads(id),
  probability_pct       INTEGER,
  expected_value        NUMERIC(18,2) NOT NULL,
  expected_close_date   DATE NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID,
  CONSTRAINT chk_opp_probability
    CHECK (probability_pct IS NULL OR probability_pct BETWEEN 0 AND 100),
  CONSTRAINT chk_opp_status CHECK (status IN ('OPEN','CONVERTED','LOST'))
);

-- §7.3 promotes a qualified lead to *an* opportunity; one open opportunity per
-- lead keeps the pipeline value in §7.5 from double-counting.
CREATE UNIQUE INDEX IF NOT EXISTS uk_opportunities_open_lead
  ON opportunities(lead_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS ix_opportunities_close
  ON opportunities(org_id, expected_close_date) WHERE status = 'OPEN';

-- §7.4 one chronological timeline per lead/opportunity/client, mirroring the
-- task activity feed. Polymorphic by design: the same call log may hang off a
-- lead today and its client for the rest of the relationship.
CREATE TABLE IF NOT EXISTS interactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  lead_id           UUID REFERENCES leads(id),
  opportunity_id    UUID REFERENCES opportunities(id),
  client_id         UUID REFERENCES clients(id),
  contact_id        UUID REFERENCES contacts(id),
  interaction_type  VARCHAR(20) NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,
  summary           TEXT NOT NULL,
  logged_by         UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID,
  CONSTRAINT chk_interaction_type CHECK (interaction_type IN
    ('CALL','MEETING','EMAIL','SITE_VISIT','OTHER')),
  -- An interaction attached to nothing cannot appear on any timeline.
  CONSTRAINT chk_interaction_subject CHECK (
    lead_id IS NOT NULL OR opportunity_id IS NOT NULL OR client_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS ix_interactions_lead    ON interactions(lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_interactions_client  ON interactions(client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_interactions_opp     ON interactions(opportunity_id, occurred_at DESC);
