/**
 * Pure grouping/filtering logic behind the More tab's module launcher.
 *
 * Dependency-free on purpose (same reasoning as rbac.ts/validators.ts): the
 * catalog and the visibility map are passed in rather than imported, so this
 * file is plain data-in/data-out and needs no React Native runtime, Metro, or
 * a built @silverline/shared to exercise with node:test. The screen (more.tsx)
 * imports MODULE_CATALOG from "@silverline/shared" (already a real workspace
 * dependency here — see package.json) and calls buildModuleLauncher with it.
 */

import { canSeeModule } from "./rbac";

export interface CatalogEntryLike {
  code: string;
  label: string;
  group: string;
}

export interface LauncherRow {
  code: string;
  label: string;
  group: string;
  /** Where tapping the row goes. Always set, even for a not-yet-built module. */
  route: string;
  /** True when this module has no real mobile screen yet. */
  comingSoon: boolean;
}

export interface LauncherGroup {
  title: string;
  items: LauncherRow[];
}

/**
 * Catalog codes already reachable from their own bottom tab — the launcher
 * lists every OTHER visible module, not a second way to the same five.
 * Mirrors rbac.ts's TAB_MODULE_CODES; kept as a literal here rather than
 * imported so this stays a pure function of its arguments.
 */
export const LAUNCHER_EXCLUDED_CODES: readonly string[] = [
  "attendance",
  "my-work",
  "leave",
  "assets",
  "survey",
];

/**
 * Catalog codes the owner decided stay on the web only — never listed in the
 * launcher, not even as "Coming soon". Org locations (2026-09-24): the
 * District→Site hierarchy is admin set-up, not something a field user looks up.
 */
export const WEB_ONLY_CODES: readonly string[] = ["org-locations"];

/** Catalog codes this round of mobile work actually built a screen for. */
export const BUILT_MODULE_ROUTES: Readonly<Record<string, string>> = {
  documents: "/documents",
  approvals: "/approvals",
  expenses: "/expenses",
  inventory: "/inventory",
  pipeline: "/pipeline",
  clients: "/clients",
  tenders: "/tenders",
  employees: "/employees",
  "attendance-exceptions": "/attendance-exceptions",
  "project-finance": "/project-finance",
  receivables: "/receivables",
  payables: "/payables",
  procurement: "/procurement",
  payroll: "/payroll",
  inbox: "/inbox",
  projects: "/projects",
  planning: "/planning",
  reports: "/reports",
  "asset-movements": "/asset-movements",
  analytics: "/analytics",
  automation: "/automation",
  "org-holidays": "/org-holidays",
};

/**
 * Build the launcher's grouped rows from the catalog and the caller's
 * resolved visibility map.
 *
 * Order follows the catalog's own order (which mirrors nav.ts's NAV_GROUPS),
 * bucketed by each entry's `group` — no separate sort, so a group's items and
 * the groups themselves appear in the same order the web sidebar uses.
 */
export function buildModuleLauncher(
  catalog: readonly CatalogEntryLike[],
  modules: Record<string, boolean> | undefined | null,
  options?: { exclude?: readonly string[]; builtRoutes?: Readonly<Record<string, string>> },
): LauncherGroup[] {
  const exclude = new Set(options?.exclude ?? LAUNCHER_EXCLUDED_CODES);
  const builtRoutes = options?.builtRoutes ?? BUILT_MODULE_ROUTES;

  const groups: LauncherGroup[] = [];
  const groupByTitle = new Map<string, LauncherGroup>();

  for (const entry of catalog) {
    if (exclude.has(entry.code) || WEB_ONLY_CODES.includes(entry.code)) continue;
    if (!canSeeModule(modules, entry.code)) continue;

    let group = groupByTitle.get(entry.group);
    if (!group) {
      group = { title: entry.group, items: [] };
      groupByTitle.set(entry.group, group);
      groups.push(group);
    }
    const builtRoute = builtRoutes[entry.code];
    group.items.push({
      code: entry.code,
      label: entry.label,
      group: entry.group,
      route: builtRoute ?? `/coming-soon?code=${encodeURIComponent(entry.code)}&label=${encodeURIComponent(entry.label)}`,
      comingSoon: !builtRoute,
    });
  }

  return groups;
}
