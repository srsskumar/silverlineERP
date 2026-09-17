-- The asset register a survey firm actually needs (enhancement note 3).
--
-- The register held an asset's code, name, serial, a free-text category and a
-- free-text condition. It could not say what the thing *is* (a rover or a
-- monitor), who made it, where it is right now, or -- the one that matters
-- when something comes back broken -- who handed it back, to whom, and in
-- what state.
--
-- Nothing is rewritten. The register already carries conditions of WORN and
-- FAIR and categories of TOOLS, IT, SAFETY and SURVEY; rewriting those to fit
-- a new dropdown would invent facts about equipment nobody re-inspected. The
-- old values stay valid on the rows that hold them and are simply not offered
-- for new ones.

/* --------------------------------------------------- extensible vocabulary */

-- Types and categories are rows, not a CHECK constraint.
--
-- The note asks for "an option to add more" for both, and that is right:
-- nobody can enumerate in advance every instrument a survey firm will buy,
-- and a register that refuses the thing you just bought gets kept in a
-- spreadsheet instead -- which is the register losing, quietly.
CREATE TABLE IF NOT EXISTS asset_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  code          varchar(64) NOT NULL,
  label         varchar(160) NOT NULL,
  display_order integer NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS asset_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  code          varchar(64) NOT NULL,
  label         varchar(160) NOT NULL,
  display_order integer NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  UNIQUE (org_id, code)
);

-- Seeded from ASSET_TYPE_SEEDS / ASSET_CATEGORY_SEEDS in @silverline/shared.
-- The seed writes the same list from TypeScript and a test pins the two
-- together: this codebase has shipped a seed that contradicted a migration
-- more than once.
INSERT INTO asset_types (org_id, code, label, display_order)
SELECT o.id, v.code, v.label, v.ord
FROM organizations o CROSS JOIN (VALUES
  ('ROVER','Rover',10), ('DRONE','Drone',20), ('TRIPOD','Tripod',30),
  ('BIPOD','Bipod',40), ('EXTERNAL_RADIO','External radio',50),
  ('EXTERNAL_RADIO_ANTENNA','External radio antenna',60),
  ('EXTERNAL_BATTERY','External battery',70), ('LAPTOP','Laptop',80),
  ('CPU','CPU',90), ('MONITOR','Monitor',100), ('OTHER','Other',999)
) AS v(code,label,ord)
ON CONFLICT (org_id, code) DO NOTHING;

INSERT INTO asset_categories (org_id, code, label, display_order)
SELECT o.id, v.code, v.label, v.ord
FROM organizations o CROSS JOIN (VALUES
  ('ELECTRONIC','Electronic',10), ('ELECTRICAL','Electrical',20),
  ('ACCESSORY','Accessories',30)
) AS v(code,label,ord)
ON CONFLICT (org_id, code) DO NOTHING;

-- Categories the register already used, kept so existing rows still resolve
-- to a name rather than showing a code the dropdown has never heard of.
INSERT INTO asset_categories (org_id, code, label, display_order, active)
SELECT DISTINCT a.org_id, a.category,
       initcap(replace(a.category, '_', ' ')), 500, true
FROM assets a
WHERE a.category IS NOT NULL AND btrim(a.category) <> ''
ON CONFLICT (org_id, code) DO NOTHING;

/* ------------------------------------------------------------- the asset */

ALTER TABLE assets
  -- What the thing is. Nullable: every asset recorded before this existed
  -- has no type, and guessing one from its name would be a guess sitting in
  -- a register people trust.
  ADD COLUMN IF NOT EXISTS asset_type_id uuid REFERENCES asset_types(id),
  ADD COLUMN IF NOT EXISTS make  varchar(160),
  ADD COLUMN IF NOT EXISTS model varchar(160),
  -- Required when the condition is "other", enforced below.
  ADD COLUMN IF NOT EXISTS condition_note text;

DO $$
BEGIN
  ALTER TABLE assets ADD CONSTRAINT chk_assets_condition_other
    CHECK (condition <> 'OTHER'
        OR (condition_note IS NOT NULL AND btrim(condition_note) <> ''));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(org_id, asset_type_id);

/* ------------------------------------------------- handing it back */

ALTER TABLE asset_assignments
  -- Who took it back. The note asks "returned to whom", and it is the
  -- question that matters when something turns up damaged a week later:
  -- without it the trail ends at the person who had it, who has every
  -- reason to say it was fine when they handed it over.
  ADD COLUMN IF NOT EXISTS returned_to_employee_id uuid REFERENCES employees(id),
  -- The condition the *receiver* recorded, which is the point. The condition
  -- column above is the state it went out in.
  ADD COLUMN IF NOT EXISTS return_condition varchar(24),
  ADD COLUMN IF NOT EXISTS return_condition_note text,
  ADD COLUMN IF NOT EXISTS received_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS notes text;

DO $$
BEGIN
  ALTER TABLE asset_assignments ADD CONSTRAINT chk_asset_return_other
    CHECK (return_condition <> 'OTHER'
        OR (return_condition_note IS NOT NULL AND btrim(return_condition_note) <> ''));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Move the condition already recorded on a closed assignment into the column
-- that now means it.
--
-- Until this migration, returning an asset overwrote `condition` -- the state
-- it went out in -- with the state it came back in. So on an already-returned
-- row, `condition` *is* the return condition; this puts it where it belongs
-- rather than inventing a reading nobody took. The issue condition for those
-- historical rows is genuinely lost, and no backfill can honestly recover it.
UPDATE asset_assignments
   SET return_condition = condition
 WHERE returned_at IS NOT NULL AND return_condition IS NULL;

DO $$
BEGIN
  -- A return has a condition. Handing equipment back without anybody saying
  -- what state it is in is how a register stops meaning anything.
  --
  -- Added after the backfill above, not before: the constraint is checked
  -- against every existing row, and production carries returned assignments
  -- that predate the column.
  ALTER TABLE asset_assignments ADD CONSTRAINT chk_asset_returned_has_condition
    CHECK (returned_at IS NULL OR return_condition IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The history query: everything that ever happened to one asset, in order.
CREATE INDEX IF NOT EXISTS idx_asset_assignments_asset_time
  ON asset_assignments(asset_id, issued_at DESC);

-- "Which assets are on this project" -- the question the project screen asks.
CREATE INDEX IF NOT EXISTS idx_asset_assignments_project
  ON asset_assignments(project_id) WHERE project_id IS NOT NULL;
