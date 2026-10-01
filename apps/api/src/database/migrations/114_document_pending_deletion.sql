-- Purge flags a document register row for later deletion instead of
-- deleting it immediately (owner decision 2026-10-01 #4, superseding the
-- fix-round-1 "register row only" ruling in documents/routes.ts).
--
-- Actual deletion is a separate, later step that does not exist yet; this
-- migration only adds the flag purge now sets.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS pending_deletion boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_deletion_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_deletion_reason text,
  ADD COLUMN IF NOT EXISTS pending_deletion_by uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS documents_pending_deletion_idx
  ON documents (org_id) WHERE pending_deletion;
