import { NAV_GROUPS, QUICK_CREATE, type NavItem } from './nav';
import { hasPermission } from './permissions';

/**
 * Whether a user can open a destination.
 *
 * Checks the permission it is named after and everything else it needs. The
 * two are separate because a page is usually named after one permission and
 * quietly depends on others.
 */
export function navItemVisible(permissions: string[] | undefined, item: NavItem): boolean {
  const actor = { permissions };
  if (item.permission && !hasPermission(actor, item.permission)) return false;
  return (item.requires ?? []).every((code) => hasPermission(actor, code));
}

/**
 * Where to send somebody who has just signed in.
 *
 * Every route used to redirect to /dashboard, which assumes two things that
 * are not true of every role: that they hold `dashboard.read`, and that the
 * board it renders is useful to them. A bid manager has neither, and landed on
 * a page whose first action was to refuse them.
 *
 * So the landing page is the first destination in the navigation the user can
 * actually open. The navigation is already ordered by how central each area is
 * to the work, which makes it the right order to fall back through — and it
 * means a role added later needs no special case here.
 */
export function landingRoute(permissions: string[] | undefined): string {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (navItemVisible(permissions, item)) return item.href;
    }
  }
  // Every destination is gated and none matched. /security is reachable by
  // anyone signed in — it is where you change your own password and enrol in
  // MFA — so it is the one honest destination left.
  return '/security';
}

/**
 * Whether a route is one the user can open at all.
 *
 * Used to decide between rendering a page and redirecting away from it, so a
 * bookmarked URL behaves the same way the navigation does.
 */
export function canOpen(permissions: string[] | undefined, href: string): boolean {
  const item = destination(href);
  if (item) return navItemVisible(permissions, item);
  // Not a navigation destination (a detail page, a form). Those carry their
  // own gates; this function does not get an opinion about them.
  return true;
}

/** The navigation or quick-create entry for a route, if it has one. */
export function destination(href: string): NavItem | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) if (item.href === href) return item;
  }
  // The create forms are reached from the top bar, not the sidebar, and are
  // gated in the same way: a quick-create form loads pickers of its own.
  for (const item of QUICK_CREATE) if (item.href === href) return item;
  return null;
}

/**
 * The first permission the route needs that these do not include, so the
 * refusal can name it -- the one thing the person can actually ask for.
 */
export function firstMissingFor(permissions: string[] | undefined, href: string): string | null {
  const item = destination(href);
  if (!item) return null;
  const actor = { permissions };
  for (const code of [item.permission, ...(item.requires ?? [])]) {
    if (code && !hasPermission(actor, code)) return code;
  }
  return null;
}
