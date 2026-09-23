/**
 * Pure display helpers for the Automation screen — dependency-free, same
 * reasoning as rbac.ts/validators.ts (see their headers).
 *
 * Mirrors packages/shared/src/v2.ts's automationSchema enums (trigger,
 * actions[].type) literally rather than importing it — update both if the
 * backend vocabulary changes.
 */

const TRIGGER_LABELS: Record<string, string> = {
  "task.create": "A task is created",
  "task.status": "A task's status changes",
  "task.assign": "A task is assigned",
  "sla.at_risk": "An SLA is at risk",
  "sla.breached": "An SLA is breached",
  "task.due": "A task falls due",
  "cycle.close": "A cycle closes",
};

const ACTION_TYPE_LABELS: Record<string, string> = {
  status: "Set status to",
  assign: "Assign to",
  label: "Apply label",
  comment: "Post comment",
  notify: "Notify",
  webhook: "Call webhook",
};

/** "A task's status changes", falling back to the raw code for a future trigger. */
export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

/** "Set status to DONE" — one action, described in a phrase. */
export function actionLabel(action: { type: string; value: string }): string {
  const verb = ACTION_TYPE_LABELS[action.type] ?? action.type;
  return `${verb} ${action.value}`;
}

export function executionStatusTone(status: string): "success" | "danger" | "neutral" {
  if (status === "SUCCEEDED") return "success";
  if (status === "FAILED") return "danger";
  return "neutral";
}
