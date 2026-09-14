-- Optional direct employee-to-fence assignment. A direct assignment takes
-- precedence over the employee's site/location hierarchy. Rows are retired by
-- status instead of deleted so assignment changes remain auditable.
CREATE TABLE IF NOT EXISTS geo_fence_employee_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  geo_fence_id UUID NOT NULL REFERENCES geo_fences(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT chk_geo_fence_employee_assignment_status
      CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT uk_geo_fence_employee_assignment
    UNIQUE (org_id, geo_fence_id, employee_id)
);

-- One explicit effective fence per employee. Site/location fences remain the
-- fallback when no ACTIVE direct assignment exists.
CREATE UNIQUE INDEX IF NOT EXISTS uk_geo_fence_employee_active
  ON geo_fence_employee_assignments(org_id, employee_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_geo_fence_employee_fence
  ON geo_fence_employee_assignments(org_id, geo_fence_id)
  WHERE status = 'ACTIVE';
