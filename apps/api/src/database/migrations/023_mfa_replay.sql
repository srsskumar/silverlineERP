-- TOTP replay defence (§14.1).
--
-- A time-based code stays valid for its whole step (and any allowed skew
-- window), so a code observed in transit or over a shoulder could be presented
-- a second time inside that window. Recording the highest counter each user has
-- already spent makes every code single-use.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_counter BIGINT;
