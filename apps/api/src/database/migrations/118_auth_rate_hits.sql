-- Authentication rate limits that every instance can see (security review
-- C-4, 2026-10-28).
--
-- The limiters counted in process memory, which was the whole picture when
-- the API was one process on one box. On Vercel it is one function instance
-- per concurrent request, each starting with empty counters, so ten guesses
-- a minute per address and per account were true of each instance and of
-- none of the deployment. The counters now live here; a row per hit, swept
-- as it ages out of the window.

CREATE TABLE IF NOT EXISTS auth_rate_hits (
  dimension  varchar(32) NOT NULL,
  key        varchar(255) NOT NULL,
  hit_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_hits_lookup
  ON auth_rate_hits(dimension, key, hit_at);
