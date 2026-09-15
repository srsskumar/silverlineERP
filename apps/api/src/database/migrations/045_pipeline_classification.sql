-- Project type and category on the pipeline (§6.2, §7.1, §8.1, §37.2).
--
-- The classification was only settable once a project existed, which is the
-- last moment it is useful. What the work *is* — an AMC on CCTV, a supply of
-- survey equipment — is known when the lead is first taken, and it is what
-- decides who bids it, which past jobs are comparable, and what the estimate
-- is anchored to.
--
-- Recording it at the lead and carrying it through the conversion also stops
-- it being re-keyed twice, which is how the same job ends up filed under three
-- different categories at three stages of its life.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS project_type_id     UUID REFERENCES project_types(id),
  ADD COLUMN IF NOT EXISTS project_category_id UUID REFERENCES project_categories(id);

ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS project_type_id     UUID REFERENCES project_types(id),
  ADD COLUMN IF NOT EXISTS project_category_id UUID REFERENCES project_categories(id);

-- Opportunities sit between a lead and a tender and carry the lineage, so the
-- classification travels with them rather than being lost at the hand-off.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS project_type_id     UUID REFERENCES project_types(id),
  ADD COLUMN IF NOT EXISTS project_category_id UUID REFERENCES project_categories(id);

ALTER TABLE private_proposals
  ADD COLUMN IF NOT EXISTS project_type_id     UUID REFERENCES project_types(id),
  ADD COLUMN IF NOT EXISTS project_category_id UUID REFERENCES project_categories(id);

CREATE INDEX IF NOT EXISTS ix_leads_category ON leads(org_id, project_category_id);
CREATE INDEX IF NOT EXISTS ix_tenders_category ON tenders(org_id, project_category_id);
