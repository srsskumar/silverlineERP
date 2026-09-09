ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_user_key UNIQUE(user_id,key);
ALTER TABLE idempotency_keys ADD COLUMN request_hash text;
-- Retain receipts for delayed mobile replay. Cleanup requires an explicit retention policy.
ALTER TABLE idempotency_keys ALTER COLUMN expires_at SET DEFAULT (now()+interval '100 years');
