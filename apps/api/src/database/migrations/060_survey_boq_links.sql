-- Bill what was measured (§note 9).
--
-- The survey module records how many acres were surveyed in each village on
-- each day. The billing module raises running-account bills against a BOQ,
-- where each line carries a cumulative measured quantity. They measure the
-- same work and had no connection, so the quantity on the bill was typed in
-- from a spreadsheet somebody kept alongside the system.
--
-- Two measurements of one job drift, and on a government contract the bill
-- has to tie to the measurement book. A drift is a rejected bill or a
-- dispute, months later, with nobody able to say which number was right.

CREATE TABLE IF NOT EXISTS survey_boq_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  boq_item_id    uuid NOT NULL REFERENCES boq_items(id) ON DELETE CASCADE,
  measure_id     uuid NOT NULL REFERENCES survey_measures(id),

  /*
   * Bill this line only for villages that have reached this stage.
   *
   * Ground truthing is not a finished parcel. Billing the acres of a village
   * that has been walked but not vectorised, QC'd and published claims work
   * that cannot be certified, and it comes back as a deduction on the next
   * bill. Null means the measurement itself is the deliverable.
   */
  stage_id       uuid REFERENCES survey_stages(id),

  /*
   * BOQ units per measure unit.
   *
   * The measure is in acres because that is how the field records it; the
   * BOQ may be written in hectares because that is how the contract was
   * drafted. Neither should have to change to suit the other.
   */
  factor         numeric(16,6) NOT NULL DEFAULT 1,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),

  /*
   * One measure per BOQ line.
   *
   * A BOQ line is one item at one rate. Measuring it from two sources leaves
   * no answer to "where did this quantity come from", which is the first
   * question asked when a bill is queried. Two measures means two lines.
   */
  CONSTRAINT survey_boq_links_item_key UNIQUE (boq_item_id),
  CONSTRAINT chk_survey_boq_factor_positive CHECK (factor > 0)
);

CREATE INDEX IF NOT EXISTS idx_survey_boq_links_org ON survey_boq_links(org_id, boq_item_id);
CREATE INDEX IF NOT EXISTS idx_survey_boq_links_measure ON survey_boq_links(org_id, measure_id);
