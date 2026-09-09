-- Full v2 domains. Business history is retained; lifecycle changes replace deletion.
CREATE TABLE vendors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),
 code text NOT NULL,name text NOT NULL,contact text,tax_id text,status text NOT NULL DEFAULT 'ACTIVE',
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES users(id),UNIQUE(org_id,code)
);
CREATE TABLE inventory_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),code text NOT NULL,name text NOT NULL,unit text NOT NULL,
 low_stock_threshold numeric(18,4) NOT NULL DEFAULT 0 CHECK(low_stock_threshold>=0),unit_cost numeric(18,4) NOT NULL DEFAULT 0 CHECK(unit_cost>=0),vendor_id uuid REFERENCES vendors(id),status text NOT NULL DEFAULT 'ACTIVE',
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES users(id),UNIQUE(org_id,code)
);
CREATE TABLE invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),serial_number text NOT NULL,vendor_id uuid NOT NULL REFERENCES vendors(id),hsn text NOT NULL,gst_enabled boolean NOT NULL,gst_rate numeric(8,4) NOT NULL CHECK(gst_rate BETWEEN 0 AND 100),subtotal numeric(18,4) NOT NULL CHECK(subtotal>=0),tax numeric(18,4) NOT NULL,total numeric(18,4) NOT NULL,payment_mode text NOT NULL,reference text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES users(id),UNIQUE(org_id,serial_number)
);
CREATE TABLE stock_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),item_id uuid NOT NULL REFERENCES inventory_items(id),direction text NOT NULL CHECK(direction IN ('IN','OUT')),quantity numeric(18,4) NOT NULL CHECK(quantity>0),reference text NOT NULL,project_id uuid REFERENCES projects(id),invoice_id uuid REFERENCES invoices(id),reason text,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX stock_item_ledger ON stock_transactions(org_id,item_id,created_at,id);
CREATE TABLE assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),asset_code text NOT NULL,serial_number text,name text NOT NULL,category text NOT NULL,vendor_id uuid REFERENCES vendors(id),condition text NOT NULL,status text NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','ASSIGNED','IN_USE','RETURNED','DAMAGED','LOST','WRITTEN_OFF')),
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES users(id),UNIQUE(org_id,asset_code),UNIQUE(org_id,serial_number)
);
CREATE TABLE asset_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),asset_id uuid NOT NULL REFERENCES assets(id),employee_id uuid NOT NULL REFERENCES employees(id),project_id uuid REFERENCES projects(id),due_date date,issued_at timestamptz NOT NULL DEFAULT now(),returned_at timestamptz,condition text NOT NULL,reason text NOT NULL,created_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX asset_one_assignment ON asset_assignments(asset_id) WHERE returned_at IS NULL;
CREATE TABLE asset_audits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),name text NOT NULL,results jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES users(id));
CREATE TABLE cycles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),project_id uuid NOT NULL REFERENCES projects(id),name text NOT NULL,start_date date NOT NULL,end_date date NOT NULL CHECK(end_date>=start_date),goal text,rollover text NOT NULL DEFAULT 'NEXT',status text NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','ACTIVE','CLOSED')),closed_at timestamptz,metrics jsonb,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES users(id)
);
ALTER TABLE tasks ADD COLUMN cycle_id uuid REFERENCES cycles(id), ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}',ADD COLUMN checklist jsonb NOT NULL DEFAULT '[]',ADD COLUMN actual_start_at timestamptz,ADD COLUMN actual_end_at timestamptz;
CREATE INDEX tasks_cycle ON tasks(cycle_id);
CREATE TABLE custom_field_definitions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),project_id uuid NOT NULL REFERENCES projects(id),field_key text NOT NULL,name text NOT NULL,field_type text NOT NULL,options jsonb NOT NULL DEFAULT '[]',required boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES users(id),UNIQUE(project_id,field_key));
CREATE TABLE domain_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),actor_id uuid REFERENCES users(id),type text NOT NULL,entity_type text NOT NULL,entity_id uuid,payload jsonb NOT NULL DEFAULT '{}',depth integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),error text);
CREATE INDEX events_pending ON domain_events(next_attempt_at) WHERE processed_at IS NULL;
CREATE TABLE automation_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),project_id uuid REFERENCES projects(id),name text NOT NULL,trigger text NOT NULL,conditions jsonb NOT NULL DEFAULT '[]',actions jsonb NOT NULL,active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,last_run_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES users(id));
CREATE TABLE automation_executions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),rule_id uuid NOT NULL REFERENCES automation_rules(id),event_id uuid NOT NULL REFERENCES domain_events(id),status text NOT NULL,results jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(rule_id,event_id));
CREATE TABLE webhook_subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),name text NOT NULL,url text NOT NULL,secret_encrypted text NOT NULL,events jsonb NOT NULL,active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES users(id));
CREATE TABLE webhook_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id),event_id uuid NOT NULL REFERENCES domain_events(id),status text NOT NULL DEFAULT 'PENDING',attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),response_status integer,error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(subscription_id,event_id));
CREATE TABLE insight_feedback (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),project_id uuid NOT NULL REFERENCES projects(id),model_version text NOT NULL,rating text NOT NULL,reason text,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES users(id));
CREATE TABLE v2_operations (key text NOT NULL,user_id uuid NOT NULL REFERENCES users(id),path text NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,key));
CREATE TABLE device_registrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),user_id uuid NOT NULL REFERENCES users(id),device_id text NOT NULL,push_token text,revoked_at timestamptz,wipe_requested_at timestamptz,last_seen_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,device_id));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE notifications DROP CONSTRAINT chk_notification_type;
ALTER TABLE notifications ADD COLUMN event_key text;
CREATE UNIQUE INDEX notifications_event_recipient ON notifications(recipient_id,event_key) WHERE event_key IS NOT NULL;
-- Activity is a separate projection. Audit remains the compliance record.
CREATE FUNCTION project_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.org_id IS NOT NULL AND NEW.entity_type IN ('task','project','cycle','stock_transaction','asset') THEN
  INSERT INTO domain_events(org_id,actor_id,type,entity_type,entity_id,payload,depth)
  VALUES(NEW.org_id,NEW.actor_id,CASE WHEN NEW.action IN ('task.status.change','task.status.override') THEN 'task.status' ELSE NEW.action END,NEW.entity_type,NEW.entity_id,COALESCE(NEW.after_state,'{}'),CASE WHEN NEW.request_id LIKE 'automation:%' THEN 1 ELSE 0 END);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER audit_to_activity AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION project_audit_event();
CREATE FUNCTION track_task_dates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='IN_PROGRESS' AND OLD.status<>'IN_PROGRESS' AND NEW.actual_start_at IS NULL THEN NEW.actual_start_at=now(); END IF;
 IF NEW.status='DONE' AND OLD.status<>'DONE' THEN NEW.actual_end_at=now(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_actual_dates BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION track_task_dates();
