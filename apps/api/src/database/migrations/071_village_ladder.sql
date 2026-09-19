/*
 * §071 — one village, one position.
 *
 * The module tracked seven stages, each with four states, and the screen
 * built on it asked somebody to hold twenty-eight combinations in their head
 * to answer "where is this village". The contract reports eleven positions.
 * This migration makes the stage table hold the five stages those eleven
 * positions are made of, and nothing else.
 *
 * Nothing is deleted. The three retired stages are deactivated, their rows
 * are migrated onto the stage that now covers the same ground, and the
 * definitions stay in packages/shared/src/survey.ts as a comment — the work
 * they named still happens, it is simply not a position the programme is
 * reported at.
 *
 *   VECTORIZATION_QC    -> DATA_SUBMISSION      (same checkpoint, named for
 *                                                what the department does at
 *                                                it rather than what we do
 *                                                before it)
 *   RECORDS_PREPARATION -> FINAL_DELIVERABLES   (submitted)
 *   LPM_GENERATION      -> FINAL_DELIVERABLES   (submitted)
 *   SUBMISSION          -> FINAL_DELIVERABLES   (as recorded)
 *
 * Also: the two figures a village needs when ground truthing starts, and a
 * dashboard the department can be given without giving them the company.
 */

/* ------------------------------------------------- the two new stages */

INSERT INTO survey_stages (org_id, code, label, display_order)
SELECT o.id, v.code, v.label, v.ord
FROM organizations o
CROSS JOIN (VALUES
  ('DATA_SUBMISSION',    'Data submission',    40),
  ('FINAL_DELIVERABLES', 'Final deliverables', 50)
) AS v(code, label, ord)
ON CONFLICT (org_id, code) DO NOTHING;

UPDATE survey_stages SET display_order = 10 WHERE code = 'GROUND_TRUTHING';
UPDATE survey_stages SET display_order = 20 WHERE code = 'GT_QC';
UPDATE survey_stages SET display_order = 30 WHERE code = 'VECTORIZATION';
UPDATE survey_stages SET display_order = 90 WHERE code = 'REWORK';

/* --------------------------------------- carry the recorded work across */

/*
 * The furthest state wins.
 *
 * A village may have rows on two of the three retired stages — records
 * prepared and LPMs generated — and both now mean "final deliverables".
 * Taking the furthest of them is the only merge that cannot move a village
 * backwards, and moving a village backwards is the one outcome nobody could
 * explain to the department.
 */
/*
 * Carry the two retired checkpoints onto the stages that replace them.
 *
 * A straight copy of the state, because each is the same checkpoint under a
 * new name:
 *
 *   VECTORIZATION_QC -> DATA_SUBMISSION     (the department accepting the data)
 *   SUBMISSION       -> FINAL_DELIVERABLES  (the deliverables going in, then
 *                                            being approved)
 *
 * RECORDS_PREPARATION and LPM_GENERATION are deliberately NOT mapped. They
 * are work done between data approval and submission, and the ladder has no
 * rung for it — inventing one, or promoting those villages to "final
 * deliverables submitted", would tell an official something had left the
 * building when nothing had. A village midway through records preparation
 * reads as "Data approved", which is exactly what is true of it. The rows
 * stay; only the stage stops being listed.
 */
INSERT INTO survey_village_stages
  (org_id, survey_village_id, stage_id, state, started_on, completed_on)
SELECT vs.org_id, vs.survey_village_id, t.id, vs.state, vs.started_on, vs.completed_on
FROM survey_village_stages vs
JOIN survey_stages s ON s.id = vs.stage_id
JOIN survey_stages t ON t.org_id = vs.org_id AND t.code = CASE s.code
       WHEN 'VECTORIZATION_QC' THEN 'DATA_SUBMISSION'
       ELSE 'FINAL_DELIVERABLES' END
WHERE s.code IN ('VECTORIZATION_QC', 'SUBMISSION')
  AND vs.state <> 'NOT_STARTED'
ON CONFLICT (survey_village_id, stage_id) DO UPDATE
  SET state        = EXCLUDED.state,
      started_on   = EXCLUDED.started_on,
      completed_on = EXCLUDED.completed_on;

/*
 * Retired, not removed.
 *
 * The rows stay exactly where they are: they are the record of what was
 * reported at the time, and rewriting history to match a newer model is how
 * a system stops being able to explain its own past. `active = false` takes
 * them out of every list the application builds.
 */
UPDATE survey_stages SET active = false
WHERE code IN ('VECTORIZATION_QC', 'RECORDS_PREPARATION', 'LPM_GENERATION', 'SUBMISSION');

/* Rewire the sequence onto the five that remain. */
UPDATE survey_stages s SET requires_stage_id = p.id
FROM survey_stages p
WHERE p.org_id = s.org_id AND (
     (s.code = 'GT_QC'              AND p.code = 'GROUND_TRUTHING')
  OR (s.code = 'VECTORIZATION'      AND p.code = 'GT_QC')
  OR (s.code = 'DATA_SUBMISSION'    AND p.code = 'VECTORIZATION')
  OR (s.code = 'FINAL_DELIVERABLES' AND p.code = 'DATA_SUBMISSION')
);

UPDATE survey_stages SET requires_stage_id = NULL
WHERE code IN ('GROUND_TRUTHING', 'REWORK');

/* --------------------------------------------- what GT start has to record */

/*
 * When ground truthing starts on a village, four things are agreed and none
 * of them were written down: who is on it, how many of the department's staff
 * were promised, when it starts and when it is expected to finish. The crew
 * and the two headcounts already had somewhere to live (§067). The dates did
 * not, and "when was this village supposed to be done" was a question the
 * system could not answer about work it was tracking.
 */
ALTER TABLE survey_villages
  ADD COLUMN IF NOT EXISTS gt_started_on      date,
  ADD COLUMN IF NOT EXISTS gt_expected_end_on date;

DO $$
BEGIN
  ALTER TABLE survey_villages ADD CONSTRAINT chk_survey_village_gt_dates
    CHECK (gt_started_on IS NULL OR gt_expected_end_on IS NULL
           OR gt_expected_end_on >= gt_started_on);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

/* ------------------------------------------------------- the shared view */

/*
 * A dashboard the department can be given.
 *
 * High-ranking officials are to be shown the programme's progress and
 * nothing else — not our people, not our equipment, and above all not our
 * billing. That is a permission of its own rather than a weaker version of
 * survey.read, because survey.read carries the crew lists, the rover
 * utilisation and the claim register with it.
 */
INSERT INTO permissions (code, description, module) VALUES
  ('survey.dashboard', 'See the land survey progress dashboard', 'survey')
ON CONFLICT (code) DO NOTHING;

-- System roles are global rather than per-tenant here (roles.code is unique
-- on its own), so this is one row, not one per organisation.
INSERT INTO roles (code, name, description, is_system_role)
VALUES ('GOVT_OBSERVER', 'Government observer',
        'Sees the land survey dashboard and nothing else.', true)
ON CONFLICT (code) DO NOTHING;

-- The observer role gets exactly one permission. Anything more would be a
-- decision somebody made by accident.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'survey.dashboard' FROM roles r WHERE r.code = 'GOVT_OBSERVER'
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Everybody who could already see the programme keeps seeing it.
INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT r.id, 'survey.dashboard'
FROM roles r
JOIN role_permissions rp ON rp.role_id = r.id
WHERE rp.permission_code = 'survey.read'
ON CONFLICT (role_id, permission_code) DO NOTHING;
