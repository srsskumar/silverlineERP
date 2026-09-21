/*
 * §077 -- what we are supplying a client, and at what price.
 *
 * A field-work project is measured: a bill of quantities, somebody with a
 * tape, an RA bill for what was actually done. boq_items serves that, and
 * is left alone -- putting GST into it would tangle the survey billing with
 * a tax question it does not have.
 *
 * A goods, services or AMC project is not measured. It is a list agreed in
 * advance, and the question the client asks is "what is the total, with
 * GST, in words". Two tables, for a reason:
 *
 *   catalogue_items is what we sell and what we normally charge.
 *   project_supply_lines is what was agreed with THIS client on THIS
 *   project, each line carrying its own copy of the price.
 *
 * The copy is the point. Changing a standard rate next quarter must not
 * silently restate a contract signed last quarter -- and the agreed price
 * stays editable on the line, because it is negotiated, not looked up.
 */

CREATE TABLE IF NOT EXISTS catalogue_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  code          varchar(50) NOT NULL,
  name          varchar(255) NOT NULL,
  kind          varchar(20) NOT NULL
    CONSTRAINT chk_catalogue_kind CHECK (kind IN ('GOOD', 'SERVICE', 'AMC')),
  uom           varchar(20) NOT NULL,
  /* HSN for goods, SAC for services -- same field, and the invoice needs it,
     so it is captured where the item is defined rather than at billing time. */
  hsn_sac       varchar(10),
  standard_rate numeric(16,4) NOT NULL DEFAULT 0
    CONSTRAINT chk_catalogue_rate CHECK (standard_rate >= 0),
  gst_rate      numeric(5,2) NOT NULL DEFAULT 18
    CONSTRAINT chk_catalogue_gst CHECK (gst_rate >= 0 AND gst_rate <= 28),
  notes         text,
  status        varchar(20) NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT chk_catalogue_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id)
);

/* Archived codes may be reused; live ones may not. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_code
  ON catalogue_items(org_id, code) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_catalogue_kind ON catalogue_items(org_id, kind, name);

CREATE TABLE IF NOT EXISTS project_supply_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  /*
   * Where the line came from, if it came from anywhere. Nullable and ON
   * DELETE SET NULL: a one-off supply never was in the catalogue, and
   * archiving a catalogue item must not take the contracts that quoted it
   * down with it.
   */
  catalogue_item_id  uuid REFERENCES catalogue_items(id) ON DELETE SET NULL,
  line_no            integer NOT NULL,
  description        varchar(500) NOT NULL,
  hsn_sac            varchar(10),
  uom                varchar(20) NOT NULL,
  quantity           numeric(16,3) NOT NULL
    CONSTRAINT chk_supply_qty CHECK (quantity > 0),
  /* The agreed price. Seeded from the catalogue, and its own copy from then on. */
  unit_price         numeric(16,4) NOT NULL
    CONSTRAINT chk_supply_price CHECK (unit_price >= 0),
  gst_rate           numeric(5,2) NOT NULL DEFAULT 18
    CONSTRAINT chk_supply_gst CHECK (gst_rate >= 0 AND gst_rate <= 28),
  /*
   * Whether the agreed price already has GST in it. Both happen -- a tender
   * quotes ex-GST, a shopfront quotes inclusive -- and getting it the wrong
   * way round misstates the invoice by eighteen per cent, so it is recorded
   * per line rather than assumed.
   */
  price_includes_gst boolean NOT NULL DEFAULT false,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS ix_supply_project ON project_supply_lines(project_id, line_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supply_line_no
  ON project_supply_lines(project_id, line_no);

/* ------------------------------------------------------- permissions */

INSERT INTO permissions (code, description, module) VALUES
  ('catalogue.read',   'See the goods and services catalogue and its standard rates', 'catalogue'),
  ('catalogue.manage', 'Add and change catalogue items and their standard rates',     'catalogue')
ON CONFLICT (code) DO NOTHING;

/*
 * Reading it goes with reading a project: whoever may look at the contract
 * may see what it is for. Changing the standard rates is a commercial
 * decision and stays with the roles that already make them.
 */
INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT r.id, 'catalogue.read'
FROM roles r
JOIN role_permissions rp ON rp.role_id = r.id
WHERE rp.permission_code = 'projects.read'
ON CONFLICT (role_id, permission_code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'catalogue.manage'
FROM roles r
WHERE r.code IN ('SUPER_ADMIN', 'ADMIN', 'BID_TENDER_MANAGER', 'SALES_BD_EXECUTIVE')
ON CONFLICT (role_id, permission_code) DO NOTHING;
