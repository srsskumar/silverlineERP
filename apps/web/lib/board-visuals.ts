/**
 * Presentation helpers for the Kanban board.
 *
 * Pure functions only — no React, no network. The board reads dense rows at a
 * glance, so every card field is reduced here to the smallest thing that still
 * carries the signal: a hue, a count, initials, a short relative time. Keeping
 * that reduction out of the component makes each rule testable on its own and
 * keeps the card markup to layout.
 */

/** Column identity hues. Each maps to a `--status-*` token in globals.css. */
export type StatusHue = 'neutral' | 'todo' | 'progress' | 'review' | 'done' | 'blocked';

/**
 * Status code → hue. Codes are open-ended: a project can add its own statuses
 * through the workflow editor (e.g. QUALITY_CHECK), so anything unrecognised
 * falls back to neutral rather than borrowing a meaning it has not earned.
 */
const STATUS_HUES: Record<string, StatusHue> = {
  BACKLOG: 'neutral',
  TO_DO: 'todo',
  TODO: 'todo',
  NEW: 'todo',
  OPEN: 'todo',
  IN_PROGRESS: 'progress',
  DOING: 'progress',
  IN_REVIEW: 'review',
  REVIEW: 'review',
  QUALITY_CHECK: 'review',
  DONE: 'done',
  COMPLETED: 'done',
  CLOSED: 'done',
  BLOCKED: 'blocked',
  CANCELLED: 'neutral',
};

export function statusHue(statusCode: string): StatusHue {
  return STATUS_HUES[String(statusCode).toUpperCase()] ?? 'neutral';
}

/** The CSS colour expression for a column, honouring a board-configured override. */
export function columnColor(statusCode: string, configured?: string | null): string {
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  if (trimmed) return trimmed;
  return `hsl(var(--status-${statusHue(statusCode)}))`;
}

/**
 * Terminal statuses. Their cards read as settled — struck through, dimmed —
 * and "Hide done" drops their columns entirely.
 */
const DONE_LIKE = new Set(['DONE', 'COMPLETED', 'CLOSED', 'CANCELLED']);

export function isDoneLike(statusCode: string): boolean {
  return DONE_LIKE.has(String(statusCode).toUpperCase());
}

/** Format a human label from a status code: IN_PROGRESS → In progress. */
export function statusLabel(statusCode: string): string {
  const words = String(statusCode).replaceAll('_', ' ').toLowerCase().trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ------------------------------------------------------------------ people */

/**
 * Up to two initials for an avatar.
 *
 * Board rows carry an assignee *id*, and the username is only sometimes joined
 * in, so this takes whatever label is available and degrades gracefully: a
 * display name gives first+last initials, a username gives its first two
 * meaningful characters, and a bare UUID gives its first two hex digits (which
 * at least stays stable per person).
 */
export function initialsOf(label: string | null | undefined): string {
  const raw = String(label ?? '').trim();
  if (!raw) return '—';
  const words = raw.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return raw.slice(0, 2).toUpperCase();
}

/**
 * A stable hue (0–359) for an avatar, derived from the id so the same person
 * is the same colour on every board, in every session, without storing one.
 */
export function avatarHue(seed: string | null | undefined): number {
  const raw = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) % 360000;
  }
  return hash % 360;
}

/** Short, copy-free reference for a task — the leading segment of its UUID. */
export function shortRef(id: string | null | undefined): string {
  const raw = String(id ?? '').replace(/-/g, '');
  return raw ? raw.slice(0, 6).toUpperCase() : '';
}

/* -------------------------------------------------------------------- time */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Coarse relative age, matching how a board is actually read: nobody needs
 * "3 months, 2 days"; they need to know whether a card is fresh or stale.
 */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const delta = now.getTime() - then;
  if (delta < 0) return 'just now';
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) {
    const n = Math.floor(delta / MINUTE);
    return `${n} minute${n === 1 ? '' : 's'} ago`;
  }
  if (delta < DAY) {
    const n = Math.floor(delta / HOUR);
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 365) {
    const n = Math.floor(days / 30);
    return `${n} month${n === 1 ? '' : 's'} ago`;
  }
  const n = Math.floor(days / 365);
  return `${n} year${n === 1 ? '' : 's'} ago`;
}

export interface DueState {
  /** Short label: "Apr 22". */
  label: string;
  /** Past its planned end and not yet finished. */
  overdue: boolean;
}

/**
 * The deadline as the board shows it.
 *
 * A finished task is never "overdue" however late it landed — the column
 * already says it is done, and colouring it red would be relitigating a
 * closed item every time someone scans the board.
 */
export function dueState(
  plannedEndDate: string | null | undefined,
  statusCode: string,
  now: Date = new Date(),
): DueState | null {
  if (!plannedEndDate) return null;
  const due = new Date(plannedEndDate);
  if (!Number.isFinite(due.getTime())) return null;
  const label = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (isDoneLike(statusCode)) return { label, overdue: false };
  // Compare dates, not instants: a task due today is not overdue at 09:00.
  const endOfDue = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate(), 23, 59, 59);
  return { label, overdue: now.getTime() > endOfDue };
}

/* --------------------------------------------------------------- checklist */

export interface ChecklistProgress {
  done: number;
  total: number;
}

/**
 * Subtask progress from the `checklist` jsonb: `[{id,title,done}]`.
 * Returns null for an empty or unrecognised checklist so the card can omit the
 * chip entirely rather than render a meaningless "0/0".
 */
export function checklistProgress(checklist: unknown): ChecklistProgress | null {
  const items = Array.isArray(checklist)
    ? checklist
    : Array.isArray((checklist as { items?: unknown })?.items)
      ? ((checklist as { items: unknown[] }).items)
      : null;
  if (!items || items.length === 0) return null;
  let done = 0;
  for (const item of items) {
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      if (row.done === true || row.checked === true || row.completed === true) done += 1;
    }
  }
  return { done, total: items.length };
}

/* ---------------------------------------------------------------- priority */

/** How many pips a priority lights up, out of three. LOW lights none. */
const PRIORITY_PIPS: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };

export function priorityPips(priority: string | null | undefined): number {
  return PRIORITY_PIPS[String(priority ?? '').toUpperCase()] ?? 0;
}

/** URGENT and HIGH read in the danger/warning hues; the rest stay neutral. */
export function priorityTone(priority: string | null | undefined): 'danger' | 'warning' | 'muted' {
  const value = String(priority ?? '').toUpperCase();
  if (value === 'URGENT') return 'danger';
  if (value === 'HIGH') return 'warning';
  return 'muted';
}
