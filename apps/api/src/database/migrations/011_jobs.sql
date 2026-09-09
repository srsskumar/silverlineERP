ALTER TABLE domain_events ADD COLUMN event_key text;
CREATE UNIQUE INDEX domain_events_key ON domain_events(org_id,event_key) WHERE event_key IS NOT NULL;
ALTER TABLE report_schedules ADD COLUMN format text NOT NULL DEFAULT 'csv' CHECK(format IN('csv','xlsx','pdf')),ADD COLUMN failures integer NOT NULL DEFAULT 0,ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE project_workflows ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN notification_preferences jsonb NOT NULL DEFAULT '{"push":true}';
CREATE TABLE notification_deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),notification_id uuid NOT NULL REFERENCES notifications(id),device_id uuid NOT NULL REFERENCES device_registrations(id),status text NOT NULL DEFAULT 'PENDING',attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),provider_id text,error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(notification_id,device_id));
CREATE INDEX notification_delivery_pending ON notification_deliveries(next_attempt_at) WHERE status='PENDING';
