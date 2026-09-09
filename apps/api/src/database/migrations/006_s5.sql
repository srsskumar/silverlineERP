-- Silverline ERP S5 migration: boards + columns, saved filters, labels +
-- task labels, notifications inbox.
-- Idempotent: every statement is IF NOT EXISTS-safe so the runner can
-- re-apply safely (version gate in migrate.ts is the first guard).
--
-- SLA is a COMPUTED read-model in S5 (no cron, no new task columns).

CREATE TABLE IF NOT EXISTS boards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  view_type VARCHAR(20) NOT NULL DEFAULT 'LIST'
    CONSTRAINT chk_board_view_type CHECK (view_type IN ('LIST', 'KANBAN')),
  filter_config JSONB NOT NULL DEFAULT '{}',
  shared BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_boards_org_project
  ON boards(org_id, project_id);
CREATE INDEX IF NOT EXISTS idx_boards_org_created
  ON boards(org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS board_columns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  status_code VARCHAR(30) NOT NULL,
  name VARCHAR(255) NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  wip_limit INTEGER,
  color VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_board_columns_board_status UNIQUE (board_id, status_code)
);

CREATE INDEX IF NOT EXISTS idx_board_columns_board
  ON board_columns(board_id, position ASC, id ASC);

CREATE TABLE IF NOT EXISTS saved_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  query_definition JSONB NOT NULL DEFAULT '{}',
  shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_filters_owner
  ON saved_filters(org_id, owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_saved_filters_project
  ON saved_filters(org_id, project_id);

CREATE TABLE IF NOT EXISTS labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uniqueness is on (org, project, name) where NULL project means
-- "global/org-wide". COALESCE is required because plain UNIQUE treats
-- NULLs as distinct (same trick as holidays.uk_holidays_org_date_scope).
CREATE UNIQUE INDEX IF NOT EXISTS uk_labels_org_project_name ON labels (
  org_id,
  COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
  name
);

CREATE INDEX IF NOT EXISTS idx_labels_org_project
  ON labels(org_id, project_id);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (task_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_task_labels_label
  ON task_labels(label_id);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL
    CONSTRAINT chk_notification_type CHECK (type IN ('TASK_ASSIGNED', 'MENTION', 'LEAVE_DECIDED', 'ATTENDANCE_DECIDED')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entity_type VARCHAR(100),
  entity_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_org_recipient
  ON notifications(org_id, recipient_id, created_at DESC, id DESC);
