-- Keep a task-linked stage row mirroring its task, from now on (owner
-- decision 2026-10-01 #7 follow-up: "the flow must not break").
--
-- Since #7 the stage row is the only thing read for a stage's state: the
-- dashboard, the internal screens, BOQ measured billing and milestone claims
-- all agree because they all read the row (SG-D3/SG-009). 115 brought every
-- linked row up to date once. Without this, the row would freeze there:
-- crews run most programmes from the task board, and a card dragged to Done
-- would no longer move the village, the bill or the claim.
--
-- A trigger rather than code in a route, because tasks change status from
-- more than one place (the board's status change, the cycle rollover in
-- planning, and whatever is written next); a trigger is the one place that
-- sees every one of them.
--
-- AFTER UPDATE, so track_task_dates() (BEFORE UPDATE, 009/015) has already
-- stamped actual_start_at / actual_end_at for this same change and the stage
-- gets those dates. The copy itself is sync_survey_stages_from_tasks() from
-- 115 -- the same function the backfill ran, so the mapping and the dating
-- cannot drift between the two.
--
-- Fires only when the status or an actual date changed; a title, assignee or
-- description edit does nothing. A task with no linked stage (most tasks) is
-- a single indexed lookup and nothing else (idx_survey_village_stages_task,
-- 050).
--
-- The row still governs: a stage set through the survey API keeps what it
-- was given until the linked task's status or dates next change, at which
-- point the board's answer is mirrored onto it.

CREATE OR REPLACE FUNCTION sync_task_linked_stage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM survey_village_stages WHERE task_id = NEW.id) THEN
    PERFORM sync_survey_stages_from_tasks(ARRAY[NEW.id]);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS task_linked_stage_sync ON tasks;
CREATE TRIGGER task_linked_stage_sync
  AFTER UPDATE ON tasks
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status
        OR NEW.actual_start_at IS DISTINCT FROM OLD.actual_start_at
        OR NEW.actual_end_at IS DISTINCT FROM OLD.actual_end_at)
  EXECUTE FUNCTION sync_task_linked_stage();
