import { z } from 'zod';

/**
 * §076 -- putting a person on the work they are on.
 *
 * Two mechanisms already existed and neither was reachable.
 *
 * Survey programmes scope themselves: `visibleProgrammes` shows a person the
 * programmes they are enrolled on or crewed to, and seventy people are
 * scoped that way today. Ordinary projects scope through
 * `user_roles.scope_type = 'project'`, which works, and which nobody had
 * ever used -- because the only way to set one was pasting a UUID into a box
 * marked "Scope record ID". Nobody could face that form, so every account in
 * the system saw every project.
 *
 * The rule, decided deliberately: the role decides the screens, the
 * assignment decides the data. Nothing here grants or removes a permission.
 */

/** What a person may see of the ordinary project register. */
export const PROJECT_ACCESS = ['ORGANISATION', 'ASSIGNED'] as const;
export type ProjectAccess = (typeof PROJECT_ACCESS)[number];

export const PROGRAMME_ROLES = [
  'GT_USER', 'QC_USER', 'QGIS_USER', 'TEAM_LEAD', 'PROJECT_MANAGER',
] as const;

export const assignmentsSchema = z.object({
  project_access: z.enum(PROJECT_ACCESS),
  project_ids: z.array(z.string().uuid()).max(500).default([]),
  programmes: z.array(z.object({
    survey_project_id: z.string().uuid(),
    project_role: z.enum(PROGRAMME_ROLES).default('GT_USER'),
  })).max(500).default([]),
}).superRefine((value, ctx) => {
  /*
   * "Only the projects below" with nothing below it would read as a
   * restriction and behave as none at all: resolveScopes treats an empty
   * project list as no project filter. Refused here rather than silently
   * doing the opposite of what the screen says.
   */
  if (value.project_access === 'ASSIGNED' && value.project_ids.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['project_ids'],
      message: 'Choose at least one project, or give them the whole organisation',
    });
  }
  const seen = new Set<string>();
  for (const [i, p] of value.programmes.entries()) {
    if (seen.has(p.survey_project_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['programmes', i, 'survey_project_id'],
        message: 'That programme is listed twice',
      });
    }
    seen.add(p.survey_project_id);
  }
});
export type AssignmentsInput = z.infer<typeof assignmentsSchema>;

export interface RoleRow {
  role_id: string;
  scope_type: string | null;
  scope_id: string | null;
}

/**
 * The `user_roles` rows a choice of project access implies.
 *
 * Only rows that are unscoped or project-scoped are this function's
 * business. A district, mandal, village or team scope is somebody's
 * deliberate decision made on the roles screen, and rewriting it from here
 * -- where the screen says nothing about geography -- would quietly undo
 * it. Those rows are carried through untouched.
 *
 * The invariant that matters: a person never ends up with no rows at all.
 * Zero rows is zero roles, which is zero permissions, which is an account
 * that cannot sign in to anything -- and it would happen silently, to
 * somebody in a mandal, on a Monday.
 */
export function plannedRoleRows(
  existing: readonly RoleRow[],
  access: ProjectAccess,
  projectIds: readonly string[],
): RoleRow[] {
  const untouched = existing.filter(
    (r) => r.scope_type !== null && r.scope_type !== 'project',
  );
  const roleIds = [...new Set(existing.map((r) => r.role_id))];
  if (roleIds.length === 0) return [...untouched];

  if (access === 'ORGANISATION') {
    return [...untouched, ...roleIds.map((role_id) => ({ role_id, scope_type: null, scope_id: null }))];
  }

  const projects = [...new Set(projectIds)];
  if (projects.length === 0) {
    // Refused by the schema, but this function is also the safety net: never
    // strip somebody's last row on the strength of an empty list.
    return [...untouched, ...roleIds.map((role_id) => ({ role_id, scope_type: null, scope_id: null }))];
  }
  const rows: RoleRow[] = [...untouched];
  for (const role_id of roleIds) {
    for (const scope_id of projects) rows.push({ role_id, scope_type: 'project', scope_id });
  }
  return rows;
}

/** Plain English for the screen, and for the audit entry. */
export function describeAccess(
  access: ProjectAccess, projects: number, programmes: number,
): string {
  const projectPart = access === 'ORGANISATION'
    ? 'every project in the organisation'
    : `${projects} project${projects === 1 ? '' : 's'}`;
  const programmePart = programmes === 0
    ? 'no survey programmes'
    : `${programmes} survey programme${programmes === 1 ? '' : 's'}`;
  return `Sees ${projectPart}, and ${programmePart}.`;
}
