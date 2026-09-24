-- A version column on invoices (task 5c fix round 1, item 3).
--
-- Every other mutation in this codebase that can race -- two people editing
-- the same record -- guards it with If-Match against a version column
-- (apps/api/src/common/domain.ts's version()). Invoices never got one: the
-- hold route and /match both predate this task and neither changes a field
-- another concurrent edit would silently clobber. PATCH /invoices/:id/lines
-- does -- two people fixing the same invoice's lines at once should not have
-- the second save silently overwrite the first's -- so it needs the guard
-- every other write-many-fields route already has.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
