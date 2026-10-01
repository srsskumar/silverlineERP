-- Backfill: copy each task-linked stage's task-derived state onto the
-- stage row itself (owner decision 2026-10-01 #7 follow-up).
--
-- The code now reads a stage's state from survey_village_stages' own
-- columns, never from the linked task (SG-D3/SG-009). Nothing before this
-- ever copied a task's status onto the stage row -- migration 050 says so in
-- as many words: for a linked stage "its own columns are left alone" -- so
-- the row sits at whatever it was when the link was first made (usually
-- NOT_STARTED). Without this backfill every village whose progress lives on
-- the task board would read as NOT_STARTED the instant the code stops
-- reading the task: zeroed billing, zeroed milestone claims, zeroed
-- dashboard progress, on real data.
--
-- The copy is one function, sync_survey_stages_from_tasks(), so that this
-- one-time backfill and the ongoing trigger in 116 (which keeps the row
-- mirroring its task from then on) run literally the same code and cannot
-- drift apart.
--
-- What it copies is exactly what the screens showed before the change, so
-- nobody sees a number move:
--
--   state        packages/shared/src/survey.ts STATUS_TO_STAGE, with
--                stageStateFromTask's fallback: TO_DO / CANCELLED / anything
--                unknown -> NOT_STARTED, IN_PROGRESS and IN_REVIEW ->
--                IN_PROGRESS, DONE -> COMPLETED, BLOCKED -> ON_HOLD.
--   started_on   the task's actual_start_at, which is what resolveStage()
--                displayed for a linked stage; the row's own value only when
--                the task has none.
--   completed_on the task's actual_end_at for a COMPLETED stage (the row's
--                own value only when the task has none); NULL for any other
--                state -- a stage that is not complete has no completion
--                date, and nothing ever displayed the row's for a linked one.
--
-- Dates are the calendar day in the organisation's own timezone, the same
-- rule the API applies (orgZoneSql / businessDay): a stage finished at
-- 00:30 IST must not be billed as the day before. A timezone setting
-- Postgres does not know falls back to Asia/Kolkata, as the API does,
-- rather than failing the statement.
--
-- Constraints (every migration runs in one transaction, so a single bad row
-- would roll back the entire deploy; under the 116 trigger, a bad row would
-- refuse the task update that caused it):
--   chk_survey_stage_completed (050) -- only rows with task_id are touched,
--     and 050 exempts those, so a DONE task with no actual_end_at becoming
--     COMPLETED-undated is allowed. The measured proposal reports such rows
--     as UNDATED_COMPLETIONS rather than billing them.
--   chk_survey_stage_dates (049, completed_on >= started_on) -- a start can
--     come from the task and a finish from the row, or vice versa, and the
--     two need not agree. Where they would not, the start is dropped: the
--     completion date is the one billing depends on, and an impossible start
--     is worse than none.
--
-- Idempotent: a row already matching its task is not touched (so updated_at
-- keeps meaning something), and a re-run only moves rows whose task has
-- changed since. Back the database up before running, as for any migration
-- that rewrites existing rows.

CREATE OR REPLACE FUNCTION sync_survey_stages_from_tasks(p_task_ids uuid[])
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  WITH zones AS (
    SELECT o.id AS org_id, COALESCE(z.name, 'Asia/Kolkata') AS tz_name
      FROM organizations o
      LEFT JOIN pg_timezone_names z ON z.name = btrim(o.settings->>'timezone')
  ),
  src AS (
    SELECT vs.id,
           CASE t.status
             WHEN 'DONE'        THEN 'COMPLETED'
             WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'
             WHEN 'IN_REVIEW'   THEN 'IN_PROGRESS'
             WHEN 'BLOCKED'     THEN 'ON_HOLD'
             ELSE 'NOT_STARTED'
           END AS new_state,
           t.actual_start_at, t.actual_end_at,
           vs.started_on, vs.completed_on,
           COALESCE(zn.tz_name, 'Asia/Kolkata') AS tz_name
      FROM survey_village_stages vs
      JOIN tasks t ON t.id = vs.task_id
      LEFT JOIN zones zn ON zn.org_id = vs.org_id
     WHERE vs.task_id = ANY(p_task_ids)
  ),
  dated AS (
    SELECT id, new_state,
           COALESCE((actual_start_at AT TIME ZONE tz_name)::date, started_on) AS new_started,
           CASE WHEN new_state = 'COMPLETED'
                THEN COALESCE((actual_end_at AT TIME ZONE tz_name)::date, completed_on)
                ELSE NULL END AS new_completed
      FROM src
  ),
  safe AS (
    SELECT id, new_state, new_completed,
           CASE WHEN new_started IS NOT NULL AND new_completed IS NOT NULL
                     AND new_started > new_completed
                THEN NULL ELSE new_started END AS new_started
      FROM dated
  )
  UPDATE survey_village_stages vs
     SET state = safe.new_state,
         started_on = safe.new_started,
         completed_on = safe.new_completed,
         updated_at = now()
    FROM safe
   WHERE vs.id = safe.id
     AND (vs.state, vs.started_on, vs.completed_on)
         IS DISTINCT FROM (safe.new_state, safe.new_started, safe.new_completed);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- The backfill: every stage row that has a task.
SELECT sync_survey_stages_from_tasks(
  COALESCE((SELECT array_agg(DISTINCT task_id) FROM survey_village_stages
             WHERE task_id IS NOT NULL), '{}'::uuid[]));
