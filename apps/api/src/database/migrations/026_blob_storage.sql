-- Store uploaded file content in the database instead of on local disk.
--
-- The API is deployed to a serverless host whose filesystem is ephemeral and
-- per-invocation: a document written during one request is gone by the next.
-- Content was already encrypted before it hit the disk, so the move is a change
-- of destination, not of protection — and payslip_documents has stored its
-- content this way since migration 010.
--
-- file_path becomes nullable rather than being dropped: rows written by an
-- earlier deployment still point at a real file on a host that has one, and the
-- read path falls back to it. Uploads are capped at 5 MiB, so a base64 TEXT
-- column is a reasonable home for them.
ALTER TABLE employee_documents
  ADD COLUMN IF NOT EXISTS content_encrypted TEXT,
  ALTER COLUMN file_path DROP NOT NULL;

ALTER TABLE task_evidence
  ADD COLUMN IF NOT EXISTS content_encrypted TEXT,
  ALTER COLUMN file_path DROP NOT NULL;

-- Generated reports are registry rows whose `entry` jsonb carried a filePath.
ALTER TABLE report_registry
  ADD COLUMN IF NOT EXISTS content_encrypted TEXT;
