/*
 * §072 — every stage carries a plan, an outcome, and the difference.
 *
 * A stage recorded when it started and when it finished, and nothing at all
 * about when it was *meant* to. So "is this village late" could not be
 * answered from the record: somebody held the plan in a spreadsheet and
 * compared by eye, which is the same failure the module was built to end.
 *
 * Four columns, and the fourth is the point. A variance with no reason is a
 * number an official will ask about in a review and nobody will be able to
 * answer for, and the answer is always known at the time and never written
 * down.
 *
 * The reason comes from the delay vocabulary the module already uses for idle
 * instruments and short days (§052). One list, so "why was this late" and
 * "why was that rover idle" can be counted together; two lists would drift
 * and make the two reports incomparable.
 */

ALTER TABLE survey_village_stages
  ADD COLUMN IF NOT EXISTS expected_start_on  date,
  ADD COLUMN IF NOT EXISTS expected_end_on    date,
  ADD COLUMN IF NOT EXISTS variance_reason    varchar(32),
  ADD COLUMN IF NOT EXISTS variance_remarks   text;

DO $$
BEGIN
  ALTER TABLE survey_village_stages ADD CONSTRAINT chk_survey_stage_expected_dates
    CHECK (expected_start_on IS NULL OR expected_end_on IS NULL
           OR expected_end_on >= expected_start_on);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  -- The same vocabulary as every other delay in this module.
  ALTER TABLE survey_village_stages ADD CONSTRAINT chk_survey_stage_variance_reason
    CHECK (variance_reason IS NULL OR variance_reason IN (
      'WEATHER','ACCESS','EQUIPMENT','ROVER','DATA_TECHNICAL','EMPLOYEE',
      'FIELD_CONDITIONS','DEPENDENCY','NO_DEPT_STAFF','OTHER'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  -- "Other" with nothing said is the option people pick to get past the form.
  ALTER TABLE survey_village_stages ADD CONSTRAINT chk_survey_stage_variance_other
    CHECK (variance_reason <> 'OTHER' OR nullif(btrim(variance_remarks), '') IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

/* ------------------------------------------- the GT dates move to the stage */

/*
 * §071 put gt_started_on and gt_expected_end_on on the village. That was one
 * commit ago and it was already wrong: they are the ground-truthing stage's
 * start and expected finish, and holding them beside the stage row that holds
 * the same two facts is how the two come to disagree. This module has a rule
 * about that and it applies to its own mistakes.
 *
 * The values move onto the stage row, then the columns go. No date is lost —
 * every one of them lands on GROUND_TRUTHING for the same village.
 */
UPDATE survey_village_stages vs
   SET started_on      = COALESCE(vs.started_on, sv.gt_started_on),
       expected_end_on = COALESCE(vs.expected_end_on, sv.gt_expected_end_on)
  FROM survey_villages sv, survey_stages s
 WHERE sv.id = vs.survey_village_id
   AND s.id = vs.stage_id AND s.code = 'GROUND_TRUTHING'
   AND (sv.gt_started_on IS NOT NULL OR sv.gt_expected_end_on IS NOT NULL);

/*
 * A village whose GT dates were set before it had a stage row at all. Rare,
 * but dropping the columns would take the dates with it.
 */
INSERT INTO survey_village_stages
  (org_id, survey_village_id, stage_id, state, started_on, expected_end_on)
SELECT sv.org_id, sv.id, s.id,
       CASE WHEN sv.gt_started_on IS NULL THEN 'NOT_STARTED' ELSE 'IN_PROGRESS' END,
       sv.gt_started_on, sv.gt_expected_end_on
  FROM survey_villages sv
  JOIN survey_stages s ON s.org_id = sv.org_id AND s.code = 'GROUND_TRUTHING'
 WHERE (sv.gt_started_on IS NOT NULL OR sv.gt_expected_end_on IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM survey_village_stages x
      WHERE x.survey_village_id = sv.id AND x.stage_id = s.id)
ON CONFLICT (survey_village_id, stage_id) DO NOTHING;

ALTER TABLE survey_villages DROP CONSTRAINT IF EXISTS chk_survey_village_gt_dates;
ALTER TABLE survey_villages
  DROP COLUMN IF EXISTS gt_started_on,
  DROP COLUMN IF EXISTS gt_expected_end_on;

/* Reading a village's stage dates is the commonest query on this table. */
CREATE INDEX IF NOT EXISTS idx_survey_village_stages_expected
  ON survey_village_stages(expected_end_on) WHERE expected_end_on IS NOT NULL;
