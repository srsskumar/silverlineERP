/**
 * Pure display/grouping helpers behind the Planning screen (app/planning.tsx)
 * — kept dependency-free and separate from the screen file, same reasoning
 * as leadsFormat.ts/procurementFormat.ts (see their headers).
 *
 * The web /planning page is a full sprint-board workbench (calendar,
 * timeline, drag-to-schedule, custom fields, workflow and SLA editors, bulk
 * task actions). None of that fits a phone screen or a field lead's actual
 * use of it there — "what iteration is this project in, and what's next" —
 * so mobile Planning is read-only: a project's cycles, grouped by where they
 * stand. Starting/closing a cycle and everything task-level stays on the web.
 */

export interface CycleLike {
  id: string;
  status: string;
  start_date: string;
  end_date: string;
}

const CYCLE_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  PLANNED: "neutral",
  ACTIVE: "info",
  CLOSED: "success",
};

export function cycleStatusTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" | "info" {
  return CYCLE_STATUS_TONE[status] ?? "neutral";
}

export interface GroupedCycles<T extends CycleLike> {
  active: T[];
  planned: T[];
  closed: T[];
}

/**
 * Partitions a project's cycles into active/upcoming/closed, each sorted so
 * the most relevant row leads: the current iteration first among actives,
 * the soonest-starting first among planned ones, the most recently closed
 * first among closed ones.
 */
export function groupCycles<T extends CycleLike>(cycles: readonly T[]): GroupedCycles<T> {
  const active = cycles
    .filter((c) => c.status === "ACTIVE")
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const planned = cycles
    .filter((c) => c.status === "PLANNED")
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const closed = cycles
    .filter((c) => c.status !== "ACTIVE" && c.status !== "PLANNED")
    .sort((a, b) => b.end_date.localeCompare(a.end_date));
  return { active, planned, closed };
}

/** "12 planned · 7 done · 5 remaining" from a closed cycle's metrics, or null before it has any. */
export function cycleMetricsSummary(
  metrics: { planned?: number; completed?: number; remaining?: number } | null | undefined,
): string | null {
  if (!metrics || metrics.planned === undefined) return null;
  const planned = metrics.planned ?? 0;
  const completed = metrics.completed ?? 0;
  const remaining = metrics.remaining ?? 0;
  return `${planned} planned · ${completed} done · ${remaining} remaining`;
}
