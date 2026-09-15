-- Inventory and material control (§44).
--
-- The existing ledger recorded a direction — IN or OUT — and no location. That
-- is an item ledger, not stock control: it cannot say whether a site has fifty
-- bags, and it cannot tell consumption from damage from a transfer, which are
-- three completely different facts wearing one label.
--
-- Four things change. Locations gain a hierarchy so stock has a *where*. The
-- transaction gains a type, so the ledger records what happened rather than
-- merely which way it went. Reservations hold stock without removing it, so
-- "available" and "on hand" stop being the same number. And a physical count
-- is approved before it moves anything, so a count cannot be used to write
-- material off with nobody signing.

-- ----------------------------------------------------------- locations

CREATE TABLE IF NOT EXISTS stock_locations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  code         VARCHAR(30) NOT NULL,
  name         VARCHAR(150) NOT NULL,
  -- Organisation → warehouse → site → sub-location (§44.2).
  kind         VARCHAR(20) NOT NULL,
  parent_id    UUID REFERENCES stock_locations(id),
  -- A site location belongs to a project, which is how material cost rolls up
  -- into that project rather than sitting in an organisation-wide pool.
  project_id   UUID REFERENCES projects(id),
  address_line TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID,
  CONSTRAINT chk_loc_kind CHECK (kind IN ('WAREHOUSE','SITE','SUB_LOCATION')),
  CONSTRAINT chk_loc_site_project CHECK (kind <> 'SITE' OR project_id IS NOT NULL),
  CONSTRAINT chk_loc_sub_parent CHECK (kind <> 'SUB_LOCATION' OR parent_id IS NOT NULL),
  CONSTRAINT chk_loc_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_loc_code ON stock_locations(org_id, code);
CREATE INDEX IF NOT EXISTS ix_loc_parent ON stock_locations(parent_id);
CREATE INDEX IF NOT EXISTS ix_loc_project ON stock_locations(project_id);

-- ------------------------------------------------------- item master (§44.1)

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS category          VARCHAR(100),
  -- `unit` is the base unit every ledger figure is stored in. The alternate is
  -- what the item is bought or issued in; without a factor, a quantity entered
  -- in it would be silently wrong, so the two travel together.
  ADD COLUMN IF NOT EXISTS alt_uom           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC(16,4),
  ADD COLUMN IF NOT EXISTS hsn_code          VARCHAR(10),
  ADD COLUMN IF NOT EXISTS gst_rate_pct      NUMERIC(6,3),
  ADD COLUMN IF NOT EXISTS batch_tracked     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS serial_tracked    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reorder_level     NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS reorder_quantity  NUMERIC(18,4);

DO $$
BEGIN
  ALTER TABLE inventory_items ADD CONSTRAINT chk_item_alt_uom
    CHECK (alt_uom IS NULL OR conversion_factor > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------ stock transactions (§44.3)

ALTER TABLE stock_transactions
  -- The recorded fact. `direction` stays for the rows that predate this and is
  -- derived from the type from here on: consumption, damage and a transfer are
  -- all "out" and mean entirely different things to a cost report.
  ADD COLUMN IF NOT EXISTS transaction_type   VARCHAR(30),
  ADD COLUMN IF NOT EXISTS from_location_id   UUID REFERENCES stock_locations(id),
  ADD COLUMN IF NOT EXISTS to_location_id     UUID REFERENCES stock_locations(id),
  ADD COLUMN IF NOT EXISTS task_id            UUID REFERENCES tasks(id),
  -- Stored in the item's base unit; what the storekeeper typed is kept beside
  -- it so the entry still reads the way they wrote it.
  ADD COLUMN IF NOT EXISTS base_quantity      NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS entered_quantity   NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS entered_uom        VARCHAR(20),
  ADD COLUMN IF NOT EXISTS batch_no           VARCHAR(50),
  ADD COLUMN IF NOT EXISTS serial_no          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS occurred_at        DATE,
  ADD COLUMN IF NOT EXISTS document_type      VARCHAR(30),
  ADD COLUMN IF NOT EXISTS document_id        UUID,
  -- Recorded when stock was issued a location did not have. Never silent: a
  -- ledger that goes negative unnoticed has stopped describing anything.
  ADD COLUMN IF NOT EXISTS negative_override  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversal_of        UUID REFERENCES stock_transactions(id);

DO $$
BEGIN
  ALTER TABLE stock_transactions ADD CONSTRAINT chk_stx_type
    CHECK (transaction_type IS NULL OR transaction_type IN (
      'OPENING_BALANCE','PURCHASE_RECEIPT','ISSUE','TRANSFER','RETURN_TO_VENDOR',
      'RETURN_FROM_PROJECT','ADJUSTMENT','DAMAGE_LOSS','CONSUMPTION','COUNT_ADJUSTMENT'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A transfer that leaves and arrives in the same place moves nothing.
DO $$
BEGIN
  ALTER TABLE stock_transactions ADD CONSTRAINT chk_stx_transfer
    CHECK (transaction_type <> 'TRANSFER'
      OR (from_location_id IS NOT NULL AND to_location_id IS NOT NULL
          AND from_location_id <> to_location_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ix_stx_item_location
  ON stock_transactions(org_id, item_id, to_location_id, from_location_id);
CREATE INDEX IF NOT EXISTS ix_stx_type ON stock_transactions(org_id, transaction_type);
CREATE INDEX IF NOT EXISTS ix_stx_document ON stock_transactions(document_type, document_id);

-- ------------------------------------------------- reservations (§44.4)

CREATE TABLE IF NOT EXISTS stock_reservations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id),
  item_id      UUID NOT NULL REFERENCES inventory_items(id),
  location_id  UUID NOT NULL REFERENCES stock_locations(id),
  quantity     NUMERIC(18,4) NOT NULL,
  project_id   UUID REFERENCES projects(id),
  task_id      UUID REFERENCES tasks(id),
  state        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  -- Stock stops being held on this date without anybody acting. A reservation
  -- nobody released would otherwise hold material for a project that finished
  -- last year, and the store would read as empty while being full.
  expires_on   DATE,
  released_at  TIMESTAMPTZ,
  released_by  UUID REFERENCES users(id),
  notes        TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID,
  CONSTRAINT chk_res_qty CHECK (quantity > 0),
  CONSTRAINT chk_res_state CHECK (state IN ('ACTIVE','RELEASED','CONSUMED','EXPIRED'))
);

CREATE INDEX IF NOT EXISTS ix_res_item_location
  ON stock_reservations(org_id, item_id, location_id) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_res_project ON stock_reservations(project_id);

-- -------------------------------------------------- stock counts (§44.5)

CREATE TABLE IF NOT EXISTS stock_counts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  count_no      VARCHAR(50) NOT NULL,
  location_id   UUID NOT NULL REFERENCES stock_locations(id),
  counted_on    DATE NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  notes         TEXT,
  -- Approving a count posts the adjustments that move real stock, so the
  -- person signing is recorded along with why they accepted the variance.
  approved_at   TIMESTAMPTZ,
  approved_by   UUID REFERENCES users(id),
  approval_reason TEXT,
  rejected_reason TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID,
  CONSTRAINT chk_count_status CHECK (status IN ('DRAFT','COUNTED','APPROVED','CANCELLED')),
  CONSTRAINT chk_count_approved CHECK (
    status <> 'APPROVED' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL
      AND approval_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_count_no ON stock_counts(org_id, count_no);
CREATE INDEX IF NOT EXISTS ix_count_location ON stock_counts(org_id, location_id, counted_on DESC);

CREATE TABLE IF NOT EXISTS stock_count_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  count_id         UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_id          UUID NOT NULL REFERENCES inventory_items(id),
  -- Frozen at the moment of counting. Recomputing it at approval time would
  -- compare the count against a ledger that has moved since.
  system_quantity  NUMERIC(18,4) NOT NULL,
  counted_quantity NUMERIC(18,4) NOT NULL,
  variance         NUMERIC(18,4) NOT NULL,
  batch_no         VARCHAR(50),
  remarks          TEXT,
  -- The adjustment this line produced, so a count-driven correction is
  -- separately auditable from an ordinary one (§44.5).
  adjustment_id    UUID REFERENCES stock_transactions(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_count_line_qty CHECK (counted_quantity >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_count_line
  ON stock_count_lines(count_id, item_id, COALESCE(batch_no, ''));
CREATE INDEX IF NOT EXISTS ix_count_line_item ON stock_count_lines(item_id);
