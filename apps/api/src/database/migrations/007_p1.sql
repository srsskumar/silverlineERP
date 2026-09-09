-- Silverline ERP P1 migration: payroll policies, runs, payslips.
-- Idempotent: every statement is IF NOT EXISTS-safe so the runner can
-- re-apply safely (version gate in migrate.ts is the first guard).
--
-- Money is NUMERIC(14,2)-capped decimals; the API computes in integer
-- paise and rounds each derived field to 2dp (see packages/shared/src/p1.ts).
-- There is NO cancelled state for runs: creation must reject ANY overlap.

CREATE TABLE IF NOT EXISTS payroll_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  per_day_divisor INTEGER NOT NULL DEFAULT 30
    CONSTRAINT chk_payroll_policy_divisor CHECK (per_day_divisor BETWEEN 1 AND 31),
  pf_pct NUMERIC(5, 2) NOT NULL DEFAULT 12
    CONSTRAINT chk_payroll_policy_pf CHECK (pf_pct >= 0 AND pf_pct <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_payroll_policies_org UNIQUE (org_id)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CONSTRAINT chk_payroll_run_status CHECK (status IN ('OPEN', 'VALIDATING', 'CALCULATED', 'REVIEW', 'APPROVED', 'LOCKED')),
  version INTEGER NOT NULL DEFAULT 1,
  employee_count INTEGER NOT NULL DEFAULT 0,
  total_gross NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_net NUMERIC(14, 2) NOT NULL DEFAULT 0,
  warnings JSONB NOT NULL DEFAULT '[]',
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approve_note TEXT,
  locked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  locked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_period
  ON payroll_runs(org_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_status
  ON payroll_runs(org_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_created
  ON payroll_runs(org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS payslips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  payroll_run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  earnings JSONB NOT NULL DEFAULT '{}',
  deductions JSONB NOT NULL DEFAULT '{}',
  gross NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(14, 2) NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_payslips_run_employee UNIQUE (payroll_run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payslips_run
  ON payslips(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payslips_employee
  ON payslips(employee_id);
CREATE INDEX IF NOT EXISTS idx_payslips_org_employee
  ON payslips(org_id, employee_id);
