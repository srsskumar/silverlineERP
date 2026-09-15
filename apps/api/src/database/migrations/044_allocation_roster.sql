-- Workforce allocation and rostering (§47).
--
-- The existing model assigns a person to a task, which answers "who is doing
-- this?" but never "is this person already promised elsewhere?". The second is
-- the question that causes trouble: a site manager commits an engineer who is
-- already full, and nobody finds out until both sites need them on the same
-- morning.
--
-- An allocation is therefore a proportion of somebody's time over a date
-- range, not a flag. Capacity conflicts fall out of overlapping ranges.

CREATE TABLE IF NOT EXISTS resource_allocations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  employee_id     UUID NOT NULL REFERENCES employees(id),
  project_id      UUID NOT NULL REFERENCES projects(id),
  -- Share of the person's working time. Not hours: a percentage survives a
  -- change to the working week, and it is what a planner actually reasons in.
  percentage      NUMERIC(5,2) NOT NULL,
  starts_on       DATE NOT NULL,
  ends_on         DATE NOT NULL,
  role_on_project VARCHAR(100),
  planned_hours   NUMERIC(10,2),
  state           VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
  -- Set when somebody knowingly committed a person past capacity. The warning
  -- exists to be acted on, not clicked through, so the reason is kept.
  override_reason TEXT,
  override_by     UUID REFERENCES users(id),
  notes           TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID,
  CONSTRAINT chk_alloc_pct CHECK (percentage > 0 AND percentage <= 100),
  CONSTRAINT chk_alloc_range CHECK (ends_on >= starts_on),
  CONSTRAINT chk_alloc_state CHECK (state IN ('PLANNED','ACTIVE','COMPLETED','CANCELLED')),
  CONSTRAINT chk_alloc_override CHECK (override_reason IS NULL OR override_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_alloc_employee
  ON resource_allocations(org_id, employee_id, starts_on, ends_on)
  WHERE state IN ('PLANNED','ACTIVE');
CREATE INDEX IF NOT EXISTS ix_alloc_project ON resource_allocations(project_id);

-- ---------------------------------------------------------------- shifts

CREATE TABLE IF NOT EXISTS work_shifts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id),
  code                  VARCHAR(30) NOT NULL,
  name                  VARCHAR(100) NOT NULL,
  starts_at             TIME NOT NULL,
  -- May be earlier than starts_at: a night shift crosses midnight, and
  -- treating that as a negative span quietly underpays whoever works it.
  ends_at               TIME NOT NULL,
  break_minutes         INTEGER NOT NULL DEFAULT 0,
  rest_days             JSONB NOT NULL DEFAULT '[]'::jsonb,
  daily_threshold_hours NUMERIC(4,2) NOT NULL DEFAULT 8,
  overtime_multiplier   NUMERIC(4,2) NOT NULL DEFAULT 1.5,
  rest_day_multiplier   NUMERIC(4,2),
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  active                BOOLEAN NOT NULL DEFAULT true,
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID,
  CONSTRAINT chk_shift_break CHECK (break_minutes >= 0 AND break_minutes <= 480),
  CONSTRAINT chk_shift_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT chk_shift_multiplier CHECK (overtime_multiplier >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_shift_code ON work_shifts(org_id, code);

-- ---------------------------------------------------------------- roster

CREATE TABLE IF NOT EXISTS roster_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  employee_id   UUID NOT NULL REFERENCES employees(id),
  shift_id      UUID NOT NULL REFERENCES work_shifts(id),
  roster_date   DATE NOT NULL,
  project_id    UUID REFERENCES projects(id),
  -- Payroll consumes the approved roster result, not raw mobile events: those
  -- say where a phone was, which is evidence rather than a decision about what
  -- somebody is owed (§47.3).
  approved_at   TIMESTAMPTZ,
  approved_by   UUID REFERENCES users(id),
  worked_hours  NUMERIC(6,2),
  overtime_hours NUMERIC(6,2),
  payable_hours NUMERIC(6,2),
  notes         TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID
);

-- One shift per person per day. Two would make "which shift were they on"
-- unanswerable, and the overtime calculation would double-count.
CREATE UNIQUE INDEX IF NOT EXISTS uk_roster_employee_day
  ON roster_entries(employee_id, roster_date);
CREATE INDEX IF NOT EXISTS ix_roster_date ON roster_entries(org_id, roster_date);
CREATE INDEX IF NOT EXISTS ix_roster_project ON roster_entries(project_id);
