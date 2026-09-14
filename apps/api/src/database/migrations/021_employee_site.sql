-- Persist the employee's assigned site so attendance can resolve the finest
-- applicable geo-fence before falling back to village/mandal/district.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES org_units(id);

CREATE INDEX IF NOT EXISTS idx_employees_site ON employees(site_id);
