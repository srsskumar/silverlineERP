-- Duplicate detection for encrypted and semi-sensitive employee identifiers
-- (§7 acceptance: "Each duplicate maps to its own stable field error").
--
-- aadhaar/pan/bank_account are stored with a random IV, so two rows holding the
-- same value produce different ciphertext and a UNIQUE index over the encrypted
-- column matches nothing. A keyed blind index (see common/crypto.ts) gives one
-- stable value per plaintext that an index can enforce, without being a bare
-- hash of a small, enumerable space.
--
-- Backfill: rows written before this migration carry NULL hashes and are
-- excluded by the partial indexes, so no pre-existing duplicate is retro-
-- rejected. Run `npm run backfill:pii-hashes --workspace=apps/api` to populate
-- them (it needs the application ENCRYPTION_KEY, which SQL does not have).
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS aadhaar_hash TEXT,
  ADD COLUMN IF NOT EXISTS pan_hash TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uk_employees_aadhaar
  ON employees(org_id, aadhaar_hash) WHERE aadhaar_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_employees_pan
  ON employees(org_id, pan_hash) WHERE pan_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_employees_bank_account
  ON employees(org_id, bank_account_hash) WHERE bank_account_hash IS NOT NULL;

-- phonepe_number is not encrypted, so it can be indexed directly.
CREATE UNIQUE INDEX IF NOT EXISTS uk_employees_phonepe
  ON employees(org_id, phonepe_number) WHERE phonepe_number IS NOT NULL;
