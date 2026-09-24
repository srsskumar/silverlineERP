-- Follow-up to 094: drops a CHECK constraint that migration briefly added
-- and should not have.
--
-- chk_vendors_msme_registered required msme_registered whenever
-- msme_category was set, which makes "registration has lapsed but the
-- Udyam number and category stay on file for the record" -- the exact state
-- packages/shared/src/ledgers.ts's payableDue is written to handle via its
-- optional msmeRegistered gate -- impossible to store. Caught by the
-- catalogue test that exercises that gate through the API before this ever
-- reached a shared database; this is what a fresh deploy needed to run
-- once, everywhere the column-adding half of 094 already landed.
--
-- A no-op wherever the constraint was never added (a fresh database that
-- picks up the corrected 094 directly).

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS chk_vendors_msme_registered;
