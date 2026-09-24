/**
 * Pure helper for the Tasks screen's quick-add — dependency-free, same
 * reasoning as leadsFormat.ts/clientsFormat.ts (see their headers).
 */

/**
 * Task 5d adversarial sweep: live-verified on dev-thor that a task created
 * with no assignee is one its own creator then cannot act on at all.
 * apps/api/src/modules/work/routes.ts's own PRD §4 comment: "holders of
 * task.update WITHOUT task.assign … may only update tasks assigned to
 * themselves" — quick-add never sent assignee_id, so an EMPLOYEE without
 * task.assign (the common mobile role) got a 403 FORBIDDEN trying to
 * transition, comment on, or attach evidence to the task they had just
 * created.
 *
 * Self-assigns only when the caller cannot assign elsewhere anyway — a
 * caller who holds task.assign keeps creating unassigned tasks by default,
 * unchanged, since they can assign it themselves afterwards and may be
 * quick-adding it for someone else.
 */
export function quickAddAssigneeId(
  canAssign: boolean,
  userId: string | null | undefined,
): string | undefined {
  return !canAssign && userId ? userId : undefined;
}

/**
 * MA-005: the date a task is due. GET /tasks rows carry planned_end_date;
 * there is no due_date column, so the list's "Due …" line never rendered.
 */
export function taskDueDate(task: { [k: string]: unknown }): string | null {
  return typeof task.planned_end_date === "string" && task.planned_end_date ? task.planned_end_date : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MA-006: the ?taskId= deep-link param, read on every change (not only as
 * the first render's initial state). An absent or array value is simply no
 * link; a string that is not a UUID is flagged so the screen can say so.
 */
export function deepLinkTaskId(raw: unknown): { id: string | null; invalid: boolean } {
  if (typeof raw !== "string" || !raw) return { id: null, invalid: false };
  return UUID_RE.test(raw) ? { id: raw, invalid: false } : { id: null, invalid: true };
}
