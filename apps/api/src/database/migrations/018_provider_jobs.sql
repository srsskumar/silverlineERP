CREATE TABLE provider_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),
 provider text NOT NULL CHECK(provider IN('SMS','WHATSAPP','ACCOUNTING')),
 created_by uuid NOT NULL REFERENCES users(id),notification_id uuid REFERENCES notifications(id),
 payload_encrypted text NOT NULL,status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','ACCEPTED','DELIVERED','FAILED','CANCELLED')),
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 provider_id text,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,notification_id)
);
CREATE INDEX provider_jobs_pending ON provider_jobs(next_attempt_at) WHERE status IN('PENDING','ACCEPTED');
