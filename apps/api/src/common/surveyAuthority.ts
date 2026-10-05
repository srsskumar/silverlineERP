import type { Pool, PoolClient } from 'pg';
import { fail } from './domain.js';

/** Enrolled on the programme, or on a crew on one of its villages. */
export async function onProgramme(
  db: Pool | PoolClient, u: { orgId: string; id: string }, programmeId: string,
): Promise<boolean> {
  return Boolean((await db.query(
    `SELECT 1 FROM users me
      WHERE me.id = $2 AND me.org_id = $1 AND me.employee_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM survey_project_employees pe
                 WHERE pe.employee_id = me.employee_id AND pe.survey_project_id = $3
                   AND pe.released_on IS NULL)
        OR EXISTS (SELECT 1 FROM survey_crew c
                     JOIN survey_villages sv ON sv.id = c.survey_village_id
                    WHERE c.employee_id = me.employee_id AND sv.survey_project_id = $3
                      AND c.released_on IS NULL))`,
    [u.orgId, u.id, programmeId])).rowCount);
}

/**
 * Whether this caller may put people on this programme (SV-018): an admin,
 * a team leader on it (the caller using this must already have confined a TL
 * to their own programmes, e.g. via projectOr404), or the survey project's PM
 * as workAuthority defines one.
 *
 * Shared across modules (SV-029): originally local to the survey module's
 * own writes (enrolment, crew assignment); apps/employees' own
 * PUT /employees/:id/assignments changes the same survey_project_employees
 * rows through a different door and needs the identical rule, not a second
 * copy that can drift from this one.
 */
export async function mayStaffProgramme(
  db: Pool | PoolClient, u: { orgId: string; id: string; roles?: string[] },
  programmeId: string,
): Promise<boolean> {
  const roles = u.roles ?? [];
  if (roles.includes('SUPER_ADMIN') || roles.includes('ADMIN')) return true;
  // A team leader staffs the programmes they are on (SV-026), not every one
  // an oversight permission such as survey.forecast happens to show them.
  if (roles.includes('TEAM_LEAD') && await onProgramme(db, u, programmeId)) return true;
  if (!roles.includes('PROJECT_MANAGER')) return false;
  const f = (await db.query(
    `SELECT COALESCE(p.project_manager_id = $2, false) AS runs_project,
            EXISTS (SELECT 1 FROM survey_project_employees pe
                      JOIN users me ON me.employee_id = pe.employee_id
                     WHERE me.id = $2 AND pe.survey_project_id = sp.id
                       AND pe.released_on IS NULL
                       AND pe.project_role = 'PROJECT_MANAGER') AS enrolled_pm,
            EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = $2 AND r.code = 'PROJECT_MANAGER'
                       AND (ur.scope_type IS NULL
                            OR (ur.scope_type = 'project' AND ur.scope_id = sp.project_id))
                   ) AS pm_scope_covers
       FROM survey_projects sp LEFT JOIN projects p ON p.id = sp.project_id
      WHERE sp.id = $3 AND sp.org_id = $1`, [u.orgId, u.id, programmeId])).rows[0];
  return Boolean(f && (f.runs_project || f.enrolled_pm || f.pm_scope_covers));
}

/**
 * The owner's staffing rule as a guard (SV-027): refuse unless this caller
 * may staff the programme. Used by every write that changes who, or what
 * kit, is on a programme.
 */
export async function requireStaffing(
  db: Pool | PoolClient, u: { orgId: string; id: string; roles?: string[] },
  programmeId: string, what: string,
): Promise<void> {
  if (!(await mayStaffProgramme(db, u, programmeId))) {
    fail('NOT_ON_THIS_PROGRAMME',
      `Only this programme’s project manager, a team leader on it or an `
      + `administrator can ${what}.`, 403);
  }
}
