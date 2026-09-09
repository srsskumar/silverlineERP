-- Silverline ERP S3 migration: leave types, balances, requests.
-- Idempotent: every statement is IF NOT EXISTS-safe so the runner can
-- re-apply safely (version gate in migrate.ts is the first guard).
--
-- current_balance is ALWAYS computed in SELECT
-- (opening_balance + credits - consumed + adjustments) and never stored.

CREATE TABLE IF NOT EXISTS leave_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_paid BOOLEAN NOT NULL DEFAULT true,
  annual_entitlement NUMERIC(10, 2) NOT NULL DEFAULT 0,
  requires_balance BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_leave_types_org_code UNIQUE (org_id, code)
);

CREATE INDEX IF NOT EXISTS idx_leave_types_org ON leave_types(org_id);

CREATE TABLE IF NOT EXISTS leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES leave_types(id),
  period_year INTEGER NOT NULL,
  opening_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  credits NUMERIC(12, 2) NOT NULL DEFAULT 0,
  consumed NUMERIC(12, 2) NOT NULL DEFAULT 0,
  adjustments NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_leave_balance UNIQUE (employee_id, leave_type_id, period_year)
);

CREATE INDEX IF NOT EXISTS idx_leave_balances_employee
  ON leave_balances(employee_id, period_year);

CREATE TABLE IF NOT EXISTS leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES leave_types(id),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  total_days INTEGER NOT NULL,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CONSTRAINT chk_leave_request_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  approval_chain JSONB NOT NULL DEFAULT '[]',
  current_approver_id UUID REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_org_created
  ON leave_requests(org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_leave_requests_employee
  ON leave_requests(employee_id, from_date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_approver
  ON leave_requests(current_approver_id) WHERE status = 'PENDING';
