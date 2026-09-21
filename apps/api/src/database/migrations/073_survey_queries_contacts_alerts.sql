/*
 * §073 — asking, reaching, and being told.
 *
 * Three things the dashboard could not do. An official could read that a
 * village was four months late and had nowhere to say "why?". Nobody could
 * find out who to ring on either side. And every alert the module raises
 * went to an in-app bell that only somebody already logged in ever sees.
 */

/* ---------------------------------------------------------- who to ring */

/*
 * Contacts on both sides of the programme.
 *
 * Deliberately two sides rather than an employee list. The department's
 * tahsildar is not in our employee register and never will be, and the
 * number a crew actually rings at eight in the morning is not in anybody's
 * HR record either. Held against the programme, optionally narrowed to a
 * district or mandal, because "who do I call about Repalle" is the question.
 */
CREATE TABLE IF NOT EXISTS survey_contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_project_id uuid NOT NULL REFERENCES survey_projects(id) ON DELETE CASCADE,
  side              varchar(16) NOT NULL
    CONSTRAINT chk_survey_contact_side CHECK (side IN ('GOVT', 'SILVERLINE')),
  name              varchar(160) NOT NULL,
  designation       varchar(160) NOT NULL,
  phone             varchar(32)  NOT NULL,
  email             varchar(255),
  -- A district or a mandal, when the contact is for part of the programme.
  org_unit_id       uuid REFERENCES org_units(id),
  notes             text,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  version           integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_survey_contacts_project
  ON survey_contacts(survey_project_id, side) WHERE active;

/* ------------------------------------------------------------- asking */

/*
 * A question, a clarification or a concern about what the dashboard says.
 *
 * Raised by whoever is reading it — including the department, who hold
 * nothing but survey.dashboard and are exactly the people most likely to
 * have a question about a figure. Answered by the people who can actually
 * answer: a team lead, a project manager, an administrator.
 *
 * The position it was raised against is recorded with it. "Why is this still
 * at GT QC" stops making sense the moment the village moves, and a question
 * nobody can reconstruct the context of is a question nobody answers.
 */
CREATE TABLE IF NOT EXISTS survey_queries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  survey_project_id uuid NOT NULL REFERENCES survey_projects(id) ON DELETE CASCADE,
  -- Null when the question is about the programme rather than one village.
  survey_village_id uuid REFERENCES survey_villages(id) ON DELETE CASCADE,
  kind              varchar(16) NOT NULL
    CONSTRAINT chk_survey_query_kind
    CHECK (kind IN ('QUESTION', 'CLARIFICATION', 'CONCERN')),
  subject           varchar(200) NOT NULL,
  body              text NOT NULL,
  /* What the village was reported at when the question was asked. */
  position_key      varchar(40),
  status            varchar(16) NOT NULL DEFAULT 'OPEN'
    CONSTRAINT chk_survey_query_status
    CHECK (status IN ('OPEN', 'ANSWERED', 'CLOSED')),
  raised_by         uuid NOT NULL REFERENCES users(id),
  raised_at         timestamptz NOT NULL DEFAULT now(),
  answer            text,
  answered_by       uuid REFERENCES users(id),
  answered_at       timestamptz,
  version           integer NOT NULL DEFAULT 1
);

DO $$
BEGIN
  -- An answered question with no answer is a status somebody set by accident.
  ALTER TABLE survey_queries ADD CONSTRAINT chk_survey_query_answered
    CHECK (status = 'OPEN' OR status = 'CLOSED'
           OR (nullif(btrim(answer), '') IS NOT NULL AND answered_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_survey_queries_open
  ON survey_queries(survey_project_id, status, raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_queries_village
  ON survey_queries(survey_village_id) WHERE survey_village_id IS NOT NULL;

/* -------------------------------------------------------- being told */

/*
 * Where the alerts go, which ones, and until when.
 *
 * An address rather than a user, because the people who need telling are not
 * all users: a district office inbox, a joint collector, a distribution list
 * somebody maintains in Outlook. `active_until` is required — a subscription
 * with no end is one that outlives the person who asked for it and becomes
 * the mail nobody can explain or stop.
 */
CREATE TABLE IF NOT EXISTS survey_alert_subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  -- Null follows every programme in the organisation.
  survey_project_id uuid REFERENCES survey_projects(id) ON DELETE CASCADE,
  email             varchar(255) NOT NULL,
  label             varchar(160),
  /* Which alerts. Empty means every kind, so a subscriber is never silent
     because somebody added a kind after they signed up. */
  kinds             text[] NOT NULL DEFAULT '{}',
  active_until      date NOT NULL,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, survey_project_id, email)
);

CREATE INDEX IF NOT EXISTS idx_survey_alert_subs_live
  ON survey_alert_subscriptions(survey_project_id) WHERE active;

/*
 * What has already been sent where.
 *
 * The same discipline as the in-app alerts: the key names the occasion, and
 * the unique index means a condition persisting is not news. Without it a
 * job running every few minutes mails the same village every few minutes,
 * and the alerts get filtered to a folder nobody opens.
 */
CREATE TABLE IF NOT EXISTS survey_alert_sent (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  subscription_id uuid NOT NULL REFERENCES survey_alert_subscriptions(id) ON DELETE CASCADE,
  event_key       text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  status          varchar(16) NOT NULL DEFAULT 'QUEUED'
    CONSTRAINT chk_survey_alert_sent_status
    CHECK (status IN ('QUEUED', 'SENT', 'FAILED')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (subscription_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_survey_alert_sent_queued
  ON survey_alert_sent(status, created_at) WHERE status = 'QUEUED';

/* ------------------------------------------------------- permissions */

INSERT INTO permissions (code, description, module) VALUES
  ('survey.query',  'Raise a question about the survey status', 'survey'),
  ('survey.answer', 'Answer a question raised on the survey',   'survey')
ON CONFLICT (code) DO NOTHING;

/*
 * Anybody who may look may ask. That includes the department: an official
 * holding nothing but the dashboard is the most likely person in the
 * programme to have a question about a figure on it, and the one with no
 * other way to put it.
 */
INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT r.id, 'survey.query'
FROM roles r
JOIN role_permissions rp ON rp.role_id = r.id
WHERE rp.permission_code IN ('survey.read', 'survey.dashboard')
ON CONFLICT (role_id, permission_code) DO NOTHING;

/* Answering is for the people who can actually answer. */
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'survey.answer'
FROM roles r
WHERE r.code IN ('SUPER_ADMIN', 'ADMIN', 'PROJECT_MANAGER', 'TEAM_LEAD')
ON CONFLICT (role_id, permission_code) DO NOTHING;
