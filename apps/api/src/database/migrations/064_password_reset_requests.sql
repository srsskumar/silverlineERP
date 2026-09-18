-- Somebody locked out, and the people who can let them back in (§note 16).
--
-- There was no way to ask. /auth/password changes your own and needs you to
-- be signed in, which is exactly what a person who has forgotten their
-- password cannot do. A field crew member in a mandal three hours from the
-- office had no route back other than telephoning somebody who happened to
-- know where the admin screen was.
--
-- Recorded rather than only notified: "I raised it on Tuesday and nothing
-- happened" is a conversation that needs a row to settle it, and a request
-- nobody actioned should still be visible a week later.

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  user_id       uuid NOT NULL REFERENCES users(id),

  /*
   * What they typed to identify themselves.
   *
   * Kept because it is evidence about the request rather than about the
   * account: somebody repeatedly asking for a colleague's password is a
   * thing worth being able to see.
   */
  requested_as  varchar(255) NOT NULL,
  requested_ip  inet,
  requested_at  timestamptz NOT NULL DEFAULT now(),

  /** Set when an administrator has dealt with it, so it stops being open. */
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users(id),
  resolution    varchar(20),

  CONSTRAINT chk_password_reset_resolution
    CHECK (resolution IS NULL OR resolution IN ('RESET', 'DECLINED', 'STALE'))
);

CREATE INDEX IF NOT EXISTS idx_password_reset_open
  ON password_reset_requests(org_id, requested_at DESC)
  WHERE resolved_at IS NULL;

/*
 * The index the rate limit reads.
 *
 * Without a limit this is a way to fill every manager's inbox by typing one
 * username repeatedly, so a request looks back at the last few minutes before
 * raising another.
 */
CREATE INDEX IF NOT EXISTS idx_password_reset_recent
  ON password_reset_requests(user_id, requested_at DESC);
