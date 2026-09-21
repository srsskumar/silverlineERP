-- Boards and saved views are archived, not deleted (BR-13).
--
-- DELETE removed the row outright. A board is somebody's configuration of how
-- a project is worked -- its columns, its WIP limits -- and a saved view is a
-- query people come back to; deleting either left nothing to restore when the
-- wrong one went, and the audit event alone cannot put the columns back.
--
-- DELETE now stamps archived_at and archived_by, and every read leaves
-- archived rows out, so to the person pressing the button nothing changes
-- except that it can be undone from the database.
--
-- Additive and safe on a live database: two nullable columns per table, no
-- rewrite, no backfill -- every existing row is live, which NULL says.

ALTER TABLE boards ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id);

ALTER TABLE saved_filters ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE saved_filters ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id);

-- The lists read live rows only; the partial indexes keep them as fast as
-- they were before archived rows began to accumulate.
CREATE INDEX IF NOT EXISTS idx_boards_live
  ON boards(org_id, project_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_saved_filters_live
  ON saved_filters(org_id, owner_id) WHERE archived_at IS NULL;
