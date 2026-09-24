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
