/*
 * §075 -- view as somebody else.
 *
 * An administrator can hold a session as another user, to see exactly what
 * that person sees and -- because the point is to test the scoping rules
 * rather than admire them -- to act as them.
 *
 * Three things make that safe enough to have:
 *
 *   1. Every write carries both names. audit_events.actor_id stays whoever
 *      the system believed was acting, so ownership, scope and every report
 *      already written against it keep working unchanged; impersonator_id
 *      names who was actually at the keyboard. "Who did this" keeps one
 *      answer even when two people are involved in it.
 *
 *   2. The sessions are their own register. Starting one writes a row with
 *      a reason and an expiry, which is evidence the access happened
 *      whether or not anything was written during it.
 *
 *   3. It borrows the ordinary session machinery rather than inventing a
 *      second way to be logged in. The token is backed by a real sessions
 *      row, so ending the impersonation revokes it on the spot instead of
 *      leaving a valid token in the wild until it expires.
 */

CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  /* Who is really at the keyboard. */
  actor_id UUID NOT NULL REFERENCES users(id),
  /* Whose screen they are looking at. */
  subject_id UUID NOT NULL REFERENCES users(id),
  /* Free text, required. An unexplained impersonation is the one you want to find later. */
  reason TEXT NOT NULL,
  /* The sessions row the access token is backed by; revoking it ends the access. */
  session_family UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  actor_ip INET,
  actor_user_agent TEXT,
  request_id VARCHAR(100),
  CONSTRAINT chk_impersonation_not_self CHECK (actor_id <> subject_id),
  CONSTRAINT chk_impersonation_window CHECK (expires_at > started_at)
);

CREATE INDEX IF NOT EXISTS idx_impersonation_actor ON impersonation_sessions(actor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_impersonation_subject ON impersonation_sessions(subject_id, started_at DESC);
/* One live session per administrator: the banner, and the stop button, have one thing to point at. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_impersonation_live
  ON impersonation_sessions(actor_id) WHERE ended_at IS NULL;

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS impersonator_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_audit_events_impersonator
  ON audit_events(impersonator_id) WHERE impersonator_id IS NOT NULL;

/* ------------------------------------------------------- permissions */

INSERT INTO permissions (code, description, module) VALUES
  ('admin.impersonate', 'Hold a session as another user to check what they can reach', 'admin')
ON CONFLICT (code) DO NOTHING;

/*
 * Administrators only, and no one else by inheritance. This is not a
 * permission that should arrive as a side effect of holding a broad read.
 */
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'admin.impersonate'
FROM roles r
WHERE r.code IN ('SUPER_ADMIN', 'ADMIN')
ON CONFLICT (role_id, permission_code) DO NOTHING;
