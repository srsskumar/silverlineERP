-- Silverline ERP S2 migration: geo-fences + attendance.
-- Idempotent: every statement is IF NOT EXISTS-safe so the runner can
-- re-apply safely (version gate in migrate.ts is the first guard).

CREATE TABLE IF NOT EXISTS geo_fences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  scope_type VARCHAR(20) NOT NULL
    CONSTRAINT chk_geo_fence_scope CHECK (scope_type IN ('district', 'mandal', 'village', 'site')),
  scope_id UUID NOT NULL REFERENCES org_units(id),
  geometry_type VARCHAR(20) NOT NULL
    CONSTRAINT chk_geo_fence_geom_type CHECK (geometry_type IN ('circle', 'polygon')),
  geometry JSONB NOT NULL,
  tolerance_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
  accuracy_threshold_meters DOUBLE PRECISION,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT chk_geo_fence_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_geo_fences_scope
  ON geo_fences(org_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_geo_fences_org_created
  ON geo_fences(org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS attendance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL
    CONSTRAINT chk_attendance_event_type CHECK (event_type IN ('CHECK_IN', 'CHECK_OUT')),
  client_timestamp TIMESTAMPTZ NOT NULL,
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  gps_accuracy DOUBLE PRECISION,
  geofence_result VARCHAR(20) NOT NULL DEFAULT 'NO_FENCE'
    CONSTRAINT chk_attendance_geofence_result CHECK (geofence_result IN ('INSIDE', 'OUTSIDE', 'NO_FENCE')),
  geofence_id UUID REFERENCES geo_fences(id) ON DELETE SET NULL,
  mock_location BOOLEAN NOT NULL DEFAULT false,
  device_id VARCHAR(255),
  app_version VARCHAR(50),
  idempotency_key VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_attendance_events_idem
  ON attendance_events(employee_id, event_type, client_timestamp, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_attendance_events_employee
  ON attendance_events(employee_id, event_type, server_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_events_idem_key
  ON attendance_events(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  check_in_event_id UUID REFERENCES attendance_events(id) ON DELETE SET NULL,
  check_out_event_id UUID REFERENCES attendance_events(id) ON DELETE SET NULL,
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  total_hours NUMERIC(6, 2),
  status VARCHAR(20) NOT NULL DEFAULT 'PARTIAL'
    CONSTRAINT chk_attendance_record_status CHECK (status IN ('PARTIAL', 'COMPLETE')),
  geofence_violation BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uk_attendance_record_day UNIQUE (employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_records_employee_day
  ON attendance_records(employee_id, work_date DESC);

CREATE TABLE IF NOT EXISTS attendance_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_record_id UUID REFERENCES attendance_records(id) ON DELETE SET NULL,
  exception_type VARCHAR(30) NOT NULL
    CONSTRAINT chk_attendance_exception_type CHECK (exception_type IN ('MISSED_PUNCH', 'LATE_CHECKIN', 'EARLY_CHECKOUT', 'OUTSIDE_GEOFENCE', 'REGULARIZATION', 'SYSTEM_FLAG')),
  reason TEXT NOT NULL,
  document_id UUID,
  source VARCHAR(10) NOT NULL DEFAULT 'USER'
    CONSTRAINT chk_attendance_exception_source CHECK (source IN ('USER', 'SYSTEM')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CONSTRAINT chk_attendance_exception_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  version INTEGER NOT NULL DEFAULT 1,
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_exceptions_employee
  ON attendance_exceptions(employee_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_exceptions_status
  ON attendance_exceptions(status, created_at DESC, id DESC);
