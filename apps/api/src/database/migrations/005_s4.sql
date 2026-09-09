-- Silverline ERP S4 migration: workspaces, project types + workflows,
-- projects, tasks, dependencies, evidence, comments, mentions.
-- Idempotent: every statement is IF NOT EXISTS-safe so the runner can
-- re-apply safely (version gate in migrate.ts is the first guard).

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT chk_workspace_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_org_created
  ON workspaces(org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS project_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_project_types_org_code UNIQUE (org_id, code)
);

CREATE INDEX IF NOT EXISTS idx_project_types_org
  ON project_types(org_id);

CREATE TABLE IF NOT EXISTS project_workflows (
  project_type_id UUID PRIMARY KEY REFERENCES project_types(id) ON DELETE CASCADE,
  statuses JSONB NOT NULL,
  allowed_transitions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  project_type_id UUID REFERENCES project_types(id) ON DELETE SET NULL,
  project_manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
  planned_start_date DATE,
  planned_end_date DATE,
  priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
    CONSTRAINT chk_project_priority CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
    CONSTRAINT chk_project_status CHECK (status IN ('DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED_PENDING_CLOSE', 'CLOSED', 'CANCELLED')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  CONSTRAINT uk_projects_org_code UNIQUE (org_id, code)
);

CREATE INDEX IF NOT EXISTS idx_projects_org_created
  ON projects(org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_projects_workspace
  ON projects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_org_status
  ON projects(org_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'TO_DO'
    CONSTRAINT chk_task_status CHECK (status IN ('TO_DO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED')),
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  village_id UUID REFERENCES org_units(id) ON DELETE SET NULL,
  planned_start_date DATE,
  planned_end_date DATE,
  priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
    CONSTRAINT chk_task_priority CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  estimated_hours NUMERIC(10, 2),
  board_position INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_org_created
  ON tasks(org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project
  ON tasks(project_id, board_position ASC, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee
  ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status
  ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  predecessor_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  successor_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_type VARCHAR(20) NOT NULL DEFAULT 'FINISH_TO_START'
    CONSTRAINT chk_task_dependency_type CHECK (dependency_type IN ('FINISH_TO_START')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT uk_task_dependency UNIQUE (predecessor_id, successor_id),
  CONSTRAINT chk_task_dependency_no_self CHECK (predecessor_id <> successor_id)
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_predecessor
  ON task_dependencies(predecessor_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_successor
  ON task_dependencies(successor_id);

CREATE TABLE IF NOT EXISTS task_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  evidence_type VARCHAR(100) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type VARCHAR(100),
  checksum VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_evidence_task
  ON task_evidence(task_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_task
  ON comments(task_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS mentions (
  comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  mentioned_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, mentioned_user_id)
);

CREATE INDEX IF NOT EXISTS idx_mentions_user
  ON mentions(mentioned_user_id);
