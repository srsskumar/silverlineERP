-- Signing in the way a field crew actually can (§34 of the specification).
--
-- Three things were missing, and the first is the one that matters:
--
--   * A crew member knows their mobile number. They do not know
--     "user_slv001_19", and they will not keep it. Login accepted only the
--     username, so in practice somebody else logs in for them, and the
--     attendance and progress records stop meaning what they say.
--   * A password an administrator set is a password the administrator knows.
--     Nothing made the person change it, so a reset left a shared secret.
--   * The number itself could not be set through the API at all -- only by
--     the seed -- so mobile login had nothing to match against.

ALTER TABLE users
  -- Set when somebody else chose the password: an administrator resetting it,
  -- or an account created with a starting password. Cleared when the person
  -- sets their own. Until then they can authenticate and do nothing else.
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  -- When the password was last set, so an account still on its original
  -- credential is visible rather than inferred.
  ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

-- Backfill: every existing password was set at some point before now, and
-- created_at is the only honest answer available. Leaving it null would read
-- as "never set", which is worse than approximately right.
UPDATE users SET password_set_at = created_at WHERE password_set_at IS NULL;

/* ------------------------------------------------- matching a mobile number */

-- The ten digits that identify an Indian mobile, whatever form the number was
-- written in. Stored generated rather than normalised on every read so the
-- lookup can be indexed -- a sequential scan of every user on each login
-- attempt is a denial-of-service waiting to be found.
--
-- Deliberately narrow: ten digits starting 6-9, after stripping a country
-- code or trunk prefix. A landline or a typo yields NULL and simply does not
-- match, which is the safe direction. A wrong match here would be somebody
-- logging into another person's account.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mobile_digits varchar(10)
  GENERATED ALWAYS AS (
    CASE
      WHEN regexp_replace(COALESCE(phone, ''), '\D', '', 'g') ~ '^(?:0*91)?0*([6-9]\d{9})$'
      THEN (regexp_match(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'),
                         '^(?:0*91)?0*([6-9]\d{9})$'))[1]
      ELSE NULL
    END
  ) STORED;

-- One account per number, per organisation.
--
-- Not a global unique: two organisations are separate tenants and may each
-- have a person with that number. Within one, two accounts sharing a number
-- would make "log in with your mobile" ambiguous, and an ambiguous login must
-- be refused -- better to refuse the duplicate at the point it is created.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_mobile
  ON users(org_id, mobile_digits) WHERE mobile_digits IS NOT NULL;
