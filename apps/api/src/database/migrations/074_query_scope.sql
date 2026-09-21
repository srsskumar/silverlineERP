/*
 * §074 — a question about a district is not a question about a village.
 *
 * Queries could be raised against one village or against the whole
 * programme, and nothing in between. But the roll-up an official actually
 * reads is by district and by mandal, and "why is Bapatla behind" is not a
 * question about any one of its four hundred villages — filing it against a
 * village picked to satisfy a foreign key would put it in front of the wrong
 * person and lose the question that was asked.
 */

ALTER TABLE survey_queries
  ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES org_units(id);

DO $$
BEGIN
  /*
   * A question is about one thing.
   *
   * A village and a district at once is not a scope anybody meant, and
   * whichever the screen chose to show it under would be wrong half the
   * time. Neither is the programme as a whole, which is the case that was
   * already there.
   */
  ALTER TABLE survey_queries ADD CONSTRAINT chk_survey_query_one_scope
    CHECK (survey_village_id IS NULL OR org_unit_id IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_survey_queries_unit
  ON survey_queries(org_unit_id) WHERE org_unit_id IS NOT NULL;
