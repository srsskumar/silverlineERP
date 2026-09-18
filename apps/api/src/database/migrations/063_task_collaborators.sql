-- More than one person on a task (§note 13).
--
-- tasks.assignee_id is one column and stays one column: it is read by the
-- board, the filters, my-work, the workload report and the analytics, and
-- replacing it wholesale would have meant touching all of them at once for a
-- change that is mostly about who else is helping.
--
-- So the owner stays the owner — the person the task is on, who answers for
-- it — and everybody else working it is a collaborator. That is also what
-- people mean when they say a task has several assignees: somebody is still
-- responsible for it.

CREATE TABLE IF NOT EXISTS task_collaborators (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id),
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   uuid REFERENCES users(id),

  /*
   * One row per person per task.
   *
   * Adding somebody twice is somebody pressing the button twice, not a second
   * kind of involvement.
   */
  CONSTRAINT task_collaborators_unique UNIQUE (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_collaborators_task
  ON task_collaborators(task_id);

/*
 * The index that matters for "what am I working on".
 *
 * my-work reads by person, and without this it would scan every collaborator
 * row in the organisation to answer for one of them.
 */
CREATE INDEX IF NOT EXISTS idx_task_collaborators_user
  ON task_collaborators(org_id, user_id);
