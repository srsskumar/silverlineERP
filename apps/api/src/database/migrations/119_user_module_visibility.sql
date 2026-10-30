-- Per-person module visibility, on top of role_module_visibility (090).
--
-- Keyed by user: the thing that signs in. No row means "follow the role
-- result"; a row is an explicit show or hide for that person. Display only,
-- exactly like the role table: no route reads it to decide access.
CREATE TABLE IF NOT EXISTS user_module_visibility (
  org_id      uuid NOT NULL REFERENCES organizations(id),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_code varchar(64) NOT NULL,
  visible     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id),
  PRIMARY KEY (org_id, user_id, module_code)
);
CREATE INDEX IF NOT EXISTS idx_user_module_visibility_org
  ON user_module_visibility(org_id);
