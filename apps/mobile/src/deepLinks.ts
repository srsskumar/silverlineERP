/**
 * A-001: where tapping an inbox row should take you, and the mobile route
 * that means.
 *
 * apps/api/src/modules/s5/routes.ts's NOTIF_COLS already resolves each
 * notification to a *web* path (`href`) server-side — the query that has the
 * row works out where it leads, rather than the client fetching the task (or
 * lead, or document…) one at a time to find out. Mirrors
 * apps/web/lib/notifications.ts's `inboxEntityHref`: the server's own `href`
 * first, then a small local fallback (LEAVE*) for an older API that has not
 * started sending it yet.
 *
 * This module's job is the one web does not have: translating that web path
 * into an expo-router path, for the handful of destinations that have a
 * mobile screen. Pure and dependency-free like validators.ts/rbac.ts.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a well-formed UUID string — the shape every entity_id/taskId is. */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export interface InboxLinkItem {
  href?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
}

/**
 * Web path → mobile expo-router path, for the destinations that have a
 * mobile screen. Returns null for anything else (an id that fails
 * `isUuid`, or a web-only destination like /admin) — the caller's job is to
 * mark the notification read and say "open on web" rather than pushing a
 * malformed or dead-end route.
 */
function mapWebPath(href: string): string | null {
  // A survey village link ("/survey?tab=villages&project=…&village=…") and
  // the reset-password admin link both carry web-only query params; only the
  // path segment decides the mobile route, or whether there is one at all.
  const path = href.split("?")[0] ?? "";

  const task = /^\/projects\/[^/?]+\/tasks\/([^/?]+)$/.exec(path);
  if (task) return isUuid(task[1]) ? `/(tabs)/tasks?taskId=${task[1]}` : null;

  const leave = /^\/leave\/([^/?]+)$/.exec(path);
  if (leave) return isUuid(leave[1]) ? "/(tabs)/leave" : null;

  const employee = /^\/employees\/([^/?]+)$/.exec(path);
  if (employee) return isUuid(employee[1]) ? "/employees" : null;

  switch (path) {
    case "/reports":
      return "/reports";
    case "/expenses":
      return "/expenses";
    case "/procurement":
      return "/procurement";
    // RA bills live under Project finance on mobile; there is no separate
    // "billing" screen (see apps/mobile/app/project-finance.tsx).
    case "/billing":
      return "/project-finance";
    case "/assets":
      return "/(tabs)/assets";
    case "/survey":
      return "/(tabs)/survey";
    default:
      // /admin?reset=… (password reset requests) has no mobile screen at
      // all — an ADMIN/SUPER_ADMIN-only web action — and anything the
      // server has not been taught to route (href null) lands here too.
      return null;
  }
}

/**
 * Resolve an inbox row to a mobile route, or null when there is no mobile
 * screen for it. Caller marks the row read either way; null additionally
 * shows a small "open on web" note instead of navigating.
 */
export function mobileDeepLink(item: InboxLinkItem): string | null {
  if (item.href) {
    return mapWebPath(item.href);
  }
  // Local fallback, mirroring notifications.ts's own fallback for an API
  // that has not started sending `href` yet.
  const type = String(item.entity_type ?? "").toUpperCase();
  if (
    isUuid(item.entity_id) &&
    (type === "LEAVE" || type === "LEAVE_REQUEST" || type === "LEAVE_REQUESTS")
  ) {
    return "/(tabs)/leave";
  }
  return null;
}
