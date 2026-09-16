-- Linking survey work to the task board (§59, extending §S4).
--
-- A village becomes a task and each of its stages a subtask, and from then on
-- the task's status is what the village's state means.
--
-- The alternative was letting a stage row and its task each hold a status,
-- which is the `Today` and `Cumulative` problem of the source spreadsheet one
-- level up: two places to write the same fact, disagreeing within a week.
--
-- Which source governs is never ambiguous. A stage with a task linked reads
-- its state from that task and its own columns are left alone; a stage with
-- no task keeps using them. Only one is ever in play, and `task_id` says
-- which.

ALTER TABLE survey_villages
  -- The task standing for the whole village. Nullable: a programme may be run
  -- without the board, and the villages are then plain register rows.
  ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE survey_village_stages
  ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;

-- ON DELETE SET NULL rather than CASCADE on both: deleting a task must not
-- delete the survey record of the village it stood for. The work happened
-- whether or not anybody still wants the card.

-- A task stands for one village, and one stage of one village. Two survey
-- rows pointing at the same task would make its status mean two things.
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_villages_task
  ON survey_villages(task_id) WHERE task_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_village_stages_task
  ON survey_village_stages(task_id) WHERE task_id IS NOT NULL;

-- The join every read makes: resolve a village's stages through their tasks.
CREATE INDEX IF NOT EXISTS idx_survey_village_stages_village
  ON survey_village_stages(survey_village_id);

-- A stage row may now exist purely to carry the link, with its state supplied
-- by the task. The original constraint required a completion date on a
-- COMPLETED stage, which is right when the row holds the state and wrong when
-- the task does — the date lives on the task then, and the stage row's own
-- state column is not maintained at all.
ALTER TABLE survey_village_stages DROP CONSTRAINT IF EXISTS chk_survey_stage_completed;

DO $$
BEGIN
  ALTER TABLE survey_village_stages ADD CONSTRAINT chk_survey_stage_completed
    CHECK (task_id IS NOT NULL OR state <> 'COMPLETED' OR completed_on IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
