-- AUDITOR keeps document.legalhold but loses document.legalhold.release
-- (owner decision 2026-09-24 #4).
--
-- 082_document_hold_release.sql split releasing a hold into its own
-- permission and, to make sure nobody lost the ability they had the day
-- before, seeded it to every role already holding document.legalhold --
-- AUDITOR included. That blanket seed was correct for the migration it was,
-- but it is not the policy: an auditor places a hold as a control, and
-- lifting one is the separate decision that a document is safe to delete
-- again. That decision is not an auditor's to make alone.
--
-- packages/shared/src/documents.ts (DOCUMENT_ROLE_GRANTS.AUDITOR) is fixed in
-- the same commit as this migration, but per 097/098/100's own precedent a
-- source change never reaches an already-seeded deployment on its own -- the
-- seed only runs once, against a database that does not exist yet -- so the
-- grant is revoked here directly too.
--
-- Idempotent: deleting a row that is not there deletes nothing. AUDITOR's
-- document.legalhold grant itself is untouched.

DELETE FROM role_permissions
WHERE permission_code = 'document.legalhold.release'
  AND role_id = (SELECT id FROM roles WHERE code = 'AUDITOR' AND org_id IS NULL);
