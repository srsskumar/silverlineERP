-- Document governance (§46).
--
-- A register, not a store. Documents already live in employee_documents,
-- task_evidence, payslip_documents and the tender tables; this indexes them
-- and everything else, so that "what expires in the next thirty days" is one
-- query rather than four that nobody ever writes.
--
-- The state of a document — valid, expiring, expired, superseded — is derived
-- on read and never stored, for the reason §45 gives about settlement
-- positions: a stored status is a status that is wrong at midnight.

CREATE TABLE IF NOT EXISTS document_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  code              varchar(64) NOT NULL,
  label             varchar(255) NOT NULL,
  category          varchar(32) NOT NULL,
  -- Owners this type may attach to. Empty means anything; a vehicle fitness
  -- certificate has no business on an employee record.
  owners            text[] NOT NULL DEFAULT '{}',
  -- Days of warning, set from how long the renewal actually takes. A single
  -- global window is what makes an expiry report either noise or a surprise.
  notice_days       integer NOT NULL DEFAULT 30,
  expiry_required   boolean NOT NULL DEFAULT false,
  -- Its lapse stops work, rather than merely being untidy.
  blocks_operations boolean NOT NULL DEFAULT false,
  retention_years   integer NOT NULL DEFAULT 3,
  confidential      boolean NOT NULL DEFAULT false,
  basis             text,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  type_id            uuid NOT NULL REFERENCES document_types(id),
  -- Polymorphic by design: the register's whole value is that it spans the
  -- entities rather than sitting inside one of them. owner_id is nullable so
  -- an organisation-level document (the GST registration, the labour licence)
  -- has somewhere to live.
  owner_type         varchar(32) NOT NULL,
  owner_id           uuid,
  title              varchar(255) NOT NULL,
  reference_number   varchar(128),
  issuing_authority  varchar(255),
  issued_on          date,
  valid_from         date,
  expires_on         date,
  revision           varchar(32),
  -- Where the bytes are, if they are anywhere. The register indexes; content
  -- stays in the table that already holds it.
  source_type        varchar(64),
  source_id          uuid,
  -- Points at the row this one replaces. The old row stays readable: the
  -- previous certificate existed, and an inspector may ask for it.
  supersedes_id      uuid REFERENCES documents(id),
  legal_hold         boolean NOT NULL DEFAULT false,
  legal_hold_reason  text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id),
  version            integer NOT NULL DEFAULT 1
);

DO $$
BEGIN
  ALTER TABLE documents ADD CONSTRAINT chk_doc_owner_type
    CHECK (owner_type IN ('employee','project','client','vendor','asset','tender','organization'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  -- A document cannot expire before it takes effect.
  ALTER TABLE documents ADD CONSTRAINT chk_doc_dates
    CHECK (expires_on IS NULL OR valid_from IS NULL OR expires_on >= valid_from);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  -- An unexplained hold is indistinguishable from an oversight three weeks on.
  ALTER TABLE documents ADD CONSTRAINT chk_doc_hold
    CHECK (NOT legal_hold OR legal_hold_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A row may be superseded once. Two rows claiming to replace the same
-- predecessor would leave two documents both presenting as current, which is
-- the exact failure the register exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_supersedes
  ON documents(supersedes_id) WHERE supersedes_id IS NOT NULL;

-- The query the register exists to answer: what is expiring, soonest first.
CREATE INDEX IF NOT EXISTS idx_documents_expiry
  ON documents(org_id, expires_on) WHERE expires_on IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_owner
  ON documents(org_id, owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_documents_type
  ON documents(org_id, type_id);

-- Seed the governed type list for every existing organisation.
--
-- Seeded rather than left empty because the first user types "Labour Licence",
-- the second types "labour license", and from then on the register cannot
-- answer the question it exists for.
INSERT INTO document_types
  (org_id, code, label, category, owners, notice_days, expiry_required,
   blocks_operations, retention_years, confidential, basis)
SELECT o.id, t.code, t.label, t.category, t.owners, t.notice_days,
       t.expiry_required, t.blocks_operations, t.retention_years, t.confidential, t.basis
FROM organizations o
CROSS JOIN (VALUES
  ('LABOUR_LICENCE','Labour licence','STATUTORY',ARRAY['organization','project'],60,true,true,3,false,
   'Contract Labour (Regulation and Abolition) Act 1970, s.12'),
  ('BOCW_REGISTRATION','BOCW registration','STATUTORY',ARRAY['organization','project'],60,true,true,3,false,
   'Building and Other Construction Workers Act 1996, s.7'),
  ('GST_REGISTRATION','GST registration','STATUTORY',ARRAY['organization','vendor','client'],30,false,true,8,false,
   'CGST Act 2017, s.25'),
  ('PAN','PAN','STATUTORY',ARRAY['organization','employee','vendor','client'],30,false,false,8,true,
   'Income Tax Act 1961, s.139A'),
  ('TAN','TAN','STATUTORY',ARRAY['organization'],30,false,false,8,false,
   'Income Tax Act 1961, s.203A'),
  ('UDYAM','Udyam registration','STATUTORY',ARRAY['organization','vendor'],30,false,false,8,false,
   'MSMED Act 2006 — governs the payment period owed to this supplier'),
  ('EPF_CODE','EPF code','STATUTORY',ARRAY['organization'],30,false,false,8,false,
   'Employees Provident Funds Act 1952'),
  ('ESIC_CODE','ESIC code','STATUTORY',ARRAY['organization'],30,false,false,8,false,
   'Employees State Insurance Act 1948'),
  ('SHOPS_ESTABLISHMENT','Shops and establishments','STATUTORY',ARRAY['organization'],45,true,false,3,false,NULL),
  ('PROFESSIONAL_TAX','Professional tax registration','STATUTORY',ARRAY['organization'],30,false,false,8,false,NULL),
  ('CAR_POLICY','Contractor''s all-risk policy','INSURANCE',ARRAY['project','organization'],45,true,true,8,false,
   'Usually a condition of the contract as well as prudence'),
  ('WC_POLICY','Workmen''s compensation policy','INSURANCE',ARRAY['project','organization'],45,true,true,8,false,
   'Employee''s Compensation Act 1923 — liability is statutory and uninsurable after the fact'),
  ('THIRD_PARTY_LIABILITY','Third-party liability policy','INSURANCE',ARRAY['project','organization'],45,true,false,8,false,NULL),
  ('VEHICLE_INSURANCE','Vehicle insurance','INSURANCE',ARRAY['asset'],30,true,true,3,false,
   'Motor Vehicles Act 1988, s.146 — driving uninsured is an offence'),
  ('LIFTING_TACKLE_CERTIFICATE','Lifting tackle test certificate','EQUIPMENT',ARRAY['asset'],30,true,true,3,false,
   'BOCW Central Rules 1998 — the equipment must be withdrawn from service on lapse'),
  ('FITNESS_CERTIFICATE','Vehicle fitness certificate','EQUIPMENT',ARRAY['asset'],30,true,true,3,false,
   'Motor Vehicles Act 1988, s.56'),
  ('PERMIT','Vehicle permit','EQUIPMENT',ARRAY['asset'],30,true,true,3,false,NULL),
  ('PUC','Pollution under control certificate','EQUIPMENT',ARRAY['asset'],7,true,false,1,false,NULL),
  ('DRIVING_LICENCE','Driving licence','PEOPLE',ARRAY['employee'],45,true,true,3,true,NULL),
  ('MEDICAL_FITNESS','Medical fitness certificate','PEOPLE',ARRAY['employee'],30,true,true,3,true,
   'BOCW Central Rules 1998 — required before deployment on site'),
  ('SAFETY_TRAINING','Safety training card','PEOPLE',ARRAY['employee'],30,true,true,3,false,NULL),
  ('EMPLOYMENT_CONTRACT','Employment contract','PEOPLE',ARRAY['employee'],30,false,false,3,true,NULL),
  ('EDUCATIONAL_CERTIFICATE','Educational certificate','PEOPLE',ARRAY['employee'],30,false,false,3,true,NULL),
  ('BANK_GUARANTEE','Bank guarantee','COMMERCIAL',ARRAY['project','tender','client'],60,true,false,8,false,
   'Expiry leaves the client unsecured; a claim period usually runs past it'),
  ('EMD','Earnest money deposit','COMMERCIAL',ARRAY['tender'],30,true,false,3,false,NULL),
  ('WORK_ORDER','Work order','COMMERCIAL',ARRAY['project'],30,false,false,8,false,NULL),
  ('AGREEMENT','Agreement','COMMERCIAL',ARRAY['project','client','vendor'],60,false,false,8,false,NULL),
  ('DRAWING','Drawing','COMMERCIAL',ARRAY['project'],30,false,false,8,false,NULL),
  ('BID_DOCUMENT','Bid document','COMMERCIAL',ARRAY['tender'],15,false,false,3,false,NULL)
) AS t(code,label,category,owners,notice_days,expiry_required,blocks_operations,
       retention_years,confidential,basis)
ON CONFLICT (org_id, code) DO NOTHING;
