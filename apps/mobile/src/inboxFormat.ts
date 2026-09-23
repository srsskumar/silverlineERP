/**
 * Pure display helpers behind the Inbox screen (app/inbox.tsx) — kept
 * dependency-free and separate from the screen file, same reasoning as
 * leadsFormat.ts/approvalsFormat.ts (see their headers).
 *
 * Mirrors apps/web/lib/notifications.ts's isUnread/unreadDotVisible: a
 * notification is unread exactly when it has no read_at, and the badge dot
 * shows whenever there is at least one such row on the page.
 */

/** True when the item is still unread (`read_at` absent). */
export function isUnread(item: { read_at?: string | null }): boolean {
  return item.read_at == null;
}

/**
 * A short, human label for a raw notification type code
 * ("TASK_ASSIGNED" -> "Task assigned"). Falls back to the raw code for
 * anything the mapping does not special-case, so an unrecognised type still
 * reads as something rather than nothing.
 */
export function formatNotificationType(type: string | undefined | null): string {
  const raw = String(type ?? "").trim();
  if (!raw) return "Notification";
  return raw
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((word, i) => (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * The distinct type codes present on a page, in first-seen order — feeds
 * the Inbox screen's type filter chips (built from whatever actually
 * appears, not a hardcoded list the server could drift from).
 */
export function distinctTypes(items: ReadonlyArray<{ type?: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const t = item.type;
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
