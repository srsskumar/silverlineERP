CREATE TABLE advisory_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),project_id uuid NOT NULL REFERENCES projects(id),task_id uuid NOT NULL REFERENCES tasks(id),evidence_id uuid NOT NULL REFERENCES task_evidence(id),
 kind text NOT NULL DEFAULT 'DUPLICATE_EVIDENCE',status text NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','CONFIRMED','DISMISSED')),model_version text NOT NULL DEFAULT 'duplicate-check-v1',factors jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz,reviewed_by uuid REFERENCES users(id),reason text,UNIQUE(evidence_id,kind)
);
CREATE INDEX evidence_checksum ON task_evidence(org_id,checksum);
CREATE FUNCTION flag_duplicate_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project uuid; matches jsonb; case_id uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('evidence:'||NEW.org_id||':'||NEW.checksum,0));
 SELECT project_id INTO project FROM tasks WHERE id=NEW.task_id;
 SELECT jsonb_agg(id) INTO matches FROM (SELECT e.id FROM task_evidence e JOIN tasks t ON t.id=e.task_id WHERE e.org_id=NEW.org_id AND e.checksum=NEW.checksum AND e.task_id<>NEW.task_id AND t.project_id=project ORDER BY e.created_at LIMIT 20) matching;
 IF matches IS NOT NULL THEN
  INSERT INTO advisory_cases(org_id,project_id,task_id,evidence_id,factors) VALUES(NEW.org_id,project,NEW.task_id,NEW.id,jsonb_build_object('match','Exact file checksum','matching_evidence_ids',matches,'recommended_action','Review whether file reuse is expected. No automatic disciplinary or task action.')) RETURNING id INTO case_id;
  INSERT INTO audit_events(org_id,actor_id,action,entity_type,entity_id,after_state) VALUES(NEW.org_id,NEW.created_by,'advisory.case.create','advisory_case',case_id,jsonb_build_object('project_id',project,'kind','DUPLICATE_EVIDENCE'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER review_duplicate_evidence AFTER INSERT ON task_evidence FOR EACH ROW EXECUTE FUNCTION flag_duplicate_evidence();
