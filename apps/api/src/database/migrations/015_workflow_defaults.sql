CREATE OR REPLACE FUNCTION track_task_dates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status NOT IN ('TO_DO','BLOCKED','CANCELLED') AND NEW.status<>OLD.status AND NEW.actual_start_at IS NULL THEN NEW.actual_start_at=now(); END IF;
 IF NEW.status='DONE' AND OLD.status<>'DONE' THEN NEW.actual_end_at=now(); END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION create_default_project_board() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE board_id uuid; workflow_statuses jsonb;
BEGIN
 INSERT INTO boards(org_id,project_id,name,view_type,shared,created_by,updated_by) VALUES(NEW.org_id,NEW.id,'Work list','LIST',true,NEW.created_by,NEW.created_by);
 INSERT INTO boards(org_id,project_id,name,view_type,shared,created_by,updated_by) VALUES(NEW.org_id,NEW.id,'Work board','KANBAN',true,NEW.created_by,NEW.created_by) RETURNING id INTO board_id;
 SELECT statuses INTO workflow_statuses FROM project_workflows WHERE project_type_id=NEW.project_type_id;
 INSERT INTO board_columns(board_id,status_code,name,position)
 SELECT board_id,value,replace(value,'_',' '),ordinality-1 FROM jsonb_array_elements_text(COALESCE(workflow_statuses,'["TO_DO","IN_PROGRESS","IN_REVIEW","BLOCKED","DONE","CANCELLED"]')) WITH ORDINALITY;
 RETURN NEW;
END $$;

WITH added AS (
 INSERT INTO boards(org_id,project_id,name,view_type,shared,created_by,updated_by)
 SELECT p.org_id,p.id,'Work board','KANBAN',true,p.created_by,p.created_by FROM projects p
 WHERE NOT EXISTS(SELECT 1 FROM boards b WHERE b.project_id=p.id AND b.view_type='KANBAN') RETURNING id,project_id
)
INSERT INTO board_columns(board_id,status_code,name,position)
 SELECT b.id,s.value,replace(s.value,'_',' '),s.ordinality-1 FROM added b JOIN projects p ON p.id=b.project_id
 LEFT JOIN project_workflow_overrides o ON o.project_id=p.id LEFT JOIN project_workflows w ON w.project_type_id=p.project_type_id
 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(o.statuses,w.statuses,'["TO_DO","IN_PROGRESS","IN_REVIEW","BLOCKED","DONE","CANCELLED"]')) WITH ORDINALITY s;
