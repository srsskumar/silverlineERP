CREATE TABLE project_workflow_overrides(project_id uuid PRIMARY KEY REFERENCES projects(id),statuses jsonb NOT NULL,allowed_transitions jsonb NOT NULL,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid REFERENCES users(id));
ALTER TABLE tasks DROP CONSTRAINT chk_task_status;
ALTER TABLE tasks ADD CONSTRAINT chk_task_status CHECK(status ~ '^[A-Z][A-Z0-9_]{0,19}$');
CREATE FUNCTION create_default_project_board() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO boards(org_id,project_id,name,view_type,shared,created_by,updated_by) VALUES(NEW.org_id,NEW.id,'Work list','LIST',true,NEW.created_by,NEW.created_by);
 RETURN NEW;
END $$;
CREATE TRIGGER default_project_board AFTER INSERT ON projects FOR EACH ROW EXECUTE FUNCTION create_default_project_board();
INSERT INTO boards(org_id,project_id,name,view_type,shared,created_by,updated_by) SELECT p.org_id,p.id,'Work list','LIST',true,p.created_by,p.created_by FROM projects p WHERE NOT EXISTS(SELECT 1 FROM boards b WHERE b.project_id=p.id);
