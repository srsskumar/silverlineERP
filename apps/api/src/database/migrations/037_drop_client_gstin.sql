-- Contract phase of the GSTIN move (expand-and-contract, opened in 032).
--
-- 032 created party_gst_registrations and backfilled it from clients.gstin and
-- vendors.gstin. The API in this release no longer reads or writes either
-- column: duplicate detection queries the registrations table, client creation
-- turns the supplied GSTIN into a primary registration, and PATCH refuses the
-- field with a pointer to the registrations endpoint.
--
-- DEPLOY ORDER MATTERS. This migration must run AFTER that API build is live.
-- Dropping the column while the previous build is still serving would 500
-- every client create for the length of the deploy, which is precisely the
-- window expand-and-contract exists to avoid.
--
-- Safety net: refuse to drop if anything failed to migrate across, rather than
-- destroying the only copy of a tax identifier.
DO $$
DECLARE stranded INTEGER;
BEGIN
  SELECT count(*) INTO stranded
  FROM clients c
  WHERE c.gstin IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM party_gst_registrations r
      WHERE r.party_type = 'CLIENT' AND r.party_id = c.id AND r.gstin = upper(c.gstin));
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% client GSTIN(s) have no registration row. Backfill them before dropping the column.', stranded;
  END IF;

  SELECT count(*) INTO stranded
  FROM vendors v
  WHERE v.gstin IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM party_gst_registrations r
      WHERE r.party_type = 'VENDOR' AND r.party_id = v.id AND r.gstin = upper(v.gstin));
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% vendor GSTIN(s) have no registration row. Backfill them before dropping the column.', stranded;
  END IF;
END $$;

DROP INDEX IF EXISTS uk_clients_gstin;
DROP INDEX IF EXISTS uk_vendors_gstin;

ALTER TABLE clients DROP COLUMN IF EXISTS gstin;
ALTER TABLE vendors DROP COLUMN IF EXISTS gstin;
