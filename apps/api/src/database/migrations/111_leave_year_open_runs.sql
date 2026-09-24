-- Tracks the automatic 1-January leave-balance year-open job (owner
-- decision, 2026-09-24, item (b)): one row per (org, year) it has already
-- run for, so a worker tick every few seconds does not re-run the same
-- org/year pair forever after the boundary passes. The manual button and
-- December banner are unaffected and stay available regardless of whether
-- this job has run -- both call the same underlying open-year logic
-- (apps/api/src/modules/leave/openYear.ts), which is independently
-- idempotent on the leave_balances natural key either way.
CREATE TABLE IF NOT EXISTS leave_year_open_runs (
  org_id UUID NOT NULL REFERENCES organizations(id),
  year INTEGER NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created INTEGER NOT NULL DEFAULT 0,
  filled INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, year)
);
