ALTER TABLE custom_field_definitions ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE custom_field_definitions ADD COLUMN project_type_id uuid REFERENCES project_types(id);
ALTER TABLE custom_field_definitions ADD CONSTRAINT custom_field_owner CHECK((project_id IS NOT NULL)::int+(project_type_id IS NOT NULL)::int=1);
CREATE UNIQUE INDEX custom_field_type_key ON custom_field_definitions(project_type_id,field_key) WHERE project_type_id IS NOT NULL;
ALTER TABLE projects ADD COLUMN sla_policy jsonb;
ALTER TABLE project_types ADD COLUMN sla_policy jsonb;
CREATE FUNCTION task_sla(task_status text,due date,project uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN task_status IN('DONE','CANCELLED') OR due IS NULL THEN 'ON_SCHEDULE'
 WHEN due<(now() AT TIME ZONE COALESCE(o.settings->>'timezone','Asia/Kolkata'))::date THEN 'OVERDUE'
 WHEN due<=(now() AT TIME ZONE COALESCE(o.settings->>'timezone','Asia/Kolkata'))::date+COALESCE((COALESCE(p.sla_policy,pt.sla_policy)->>'at_risk_days')::int,2) THEN 'AT_RISK'
 ELSE 'ON_SCHEDULE' END FROM projects p JOIN organizations o ON o.id=p.org_id LEFT JOIN project_types pt ON pt.id=p.project_type_id WHERE p.id=project
$$;
