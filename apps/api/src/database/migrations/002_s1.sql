-- Silverline ERP S1 migration: org units, employees, documents, holidays.
-- Idempotent: every statement is IF NOT EXISTS / ON CONFLICT-safe so the
-- runner can re-apply safely (version gate in migrate.ts is the first guard).

-- Single-table org hierarchy (district -> mandal -> village -> site).
CREATE TABLE IF NOT EXISTS org_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  type VARCHAR(20) NOT NULL
    CONSTRAINT chk_org_unit_type CHECK (type IN ('district', 'mandal', 'village', 'site')),
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  parent_id UUID REFERENCES org_units(id),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT chk_org_unit_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT uk_org_unit_code UNIQUE (org_id, type, code)
);

CREATE INDEX IF NOT EXISTS idx_org_units_org_type ON org_units(org_id, type);
CREATE INDEX IF NOT EXISTS idx_org_units_parent ON org_units(parent_id);
CREATE INDEX IF NOT EXISTS idx_org_units_org_parent ON org_units(org_id, parent_id);

CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  emp_no VARCHAR(50) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100),
  father_name VARCHAR(200),
  date_of_birth DATE,
  gender VARCHAR(20),
  phone VARCHAR(20) NOT NULL,
  phone_secondary VARCHAR(20),
  email VARCHAR(255),
  aadhaar_encrypted TEXT,
  pan_encrypted TEXT,
  address TEXT,
  district_id UUID REFERENCES org_units(id),
  mandal_id UUID REFERENCES org_units(id),
  village_id UUID REFERENCES org_units(id),
  designation VARCHAR(100),
  department VARCHAR(100),
  date_of_joining DATE NOT NULL,
  date_of_exit DATE,
  exit_reason TEXT,
  exit_approved_by UUID REFERENCES users(id),
  reports_to UUID REFERENCES employees(id),
  salary_basic DECIMAL(12, 2),
  bank_name VARCHAR(100),
  bank_account_encrypted TEXT,
  bank_ifsc VARCHAR(20),
  phonepe_number VARCHAR(20),
  education TEXT,
  skills JSONB NOT NULL DEFAULT '[]',
  experience_years DECIMAL(4, 1),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CONSTRAINT chk_employee_status CHECK (status IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'EXITED')),
  status_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT uk_emp_no UNIQUE (org_id, emp_no),
  CONSTRAINT uk_emp_phone UNIQUE (org_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_employees_org_status ON employees(org_id, status);
CREATE INDEX IF NOT EXISTS idx_employees_reports_to ON employees(reports_to);
CREATE INDEX IF NOT EXISTS idx_employees_district ON employees(district_id);
CREATE INDEX IF NOT EXISTS idx_employees_mandal ON employees(mandal_id);
CREATE INDEX IF NOT EXISTS idx_employees_village ON employees(village_id);
CREATE INDEX IF NOT EXISTS idx_employees_org_created ON employees(org_id, created_at DESC, id DESC);

-- Link users to their employee row (powers GET /employees/me).
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id);

CREATE TABLE IF NOT EXISTS employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  doc_type VARCHAR(100) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type VARCHAR(100),
  checksum VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_employee_documents_employee
  ON employee_documents(employee_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  date DATE NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL
    CONSTRAINT chk_holiday_type CHECK (type IN ('national', 'regional', 'local', 'weekly_off', 'manual')),
  scope_type VARCHAR(50),
  scope_id UUID,
  source VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

-- Uniqueness is on (org, date, scope) where NULL scope means "org-wide".
-- COALESCE is required because plain UNIQUE treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uk_holidays_org_date_scope ON holidays (
  org_id,
  date,
  COALESCE(scope_type, ''),
  COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE INDEX IF NOT EXISTS idx_holidays_org_date ON holidays(org_id, date);
