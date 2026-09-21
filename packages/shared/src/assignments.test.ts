import { describe, expect, it } from 'vitest';
import { assignmentsSchema, plannedRoleRows, describeAccess } from './assignments.js';

const EMP = 'role-employee';
const TL = 'role-team-lead';
const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';

describe('plannedRoleRows', () => {
  it('gives the whole organisation one unscoped row per role', () => {
    const rows = plannedRoleRows(
      [{ role_id: EMP, scope_type: 'project', scope_id: P1 },
       { role_id: TL, scope_type: 'project', scope_id: P1 }],
      'ORGANISATION', [],
    );
    expect(rows).toEqual([
      { role_id: EMP, scope_type: null, scope_id: null },
      { role_id: TL, scope_type: null, scope_id: null },
    ]);
  });

  it('gives one row per role per project when restricted', () => {
    const rows = plannedRoleRows(
      [{ role_id: EMP, scope_type: null, scope_id: null }],
      'ASSIGNED', [P1, P2],
    );
    expect(rows).toEqual([
      { role_id: EMP, scope_type: 'project', scope_id: P1 },
      { role_id: EMP, scope_type: 'project', scope_id: P2 },
    ]);
  });

  it('carries a geography or team scope through untouched', () => {
    /*
     * Somebody set that on the roles screen. This screen says nothing about
     * districts, so it has no business rewriting one.
     */
    const rows = plannedRoleRows(
      [{ role_id: EMP, scope_type: 'district', scope_id: 'd1' },
       { role_id: EMP, scope_type: null, scope_id: null }],
      'ASSIGNED', [P1],
    );
    expect(rows).toContainEqual({ role_id: EMP, scope_type: 'district', scope_id: 'd1' });
    expect(rows).toContainEqual({ role_id: EMP, scope_type: 'project', scope_id: P1 });
  });

  it('never strips somebody down to no rows at all', () => {
    // Zero rows is zero roles is zero permissions -- an account that can
    // sign in and reach nothing, silently.
    expect(plannedRoleRows([{ role_id: EMP, scope_type: null, scope_id: null }], 'ASSIGNED', []))
      .toEqual([{ role_id: EMP, scope_type: null, scope_id: null }]);
  });

  it('is empty only when there was nothing to begin with', () => {
    expect(plannedRoleRows([], 'ORGANISATION', [])).toEqual([]);
  });

  it('does not duplicate a project listed twice', () => {
    expect(plannedRoleRows(
      [{ role_id: EMP, scope_type: null, scope_id: null }], 'ASSIGNED', [P1, P1],
    )).toHaveLength(1);
  });
});

describe('the request', () => {
  it('refuses "only the projects below" with nothing below it', () => {
    const bad = assignmentsSchema.safeParse({ project_access: 'ASSIGNED', project_ids: [] });
    expect(bad.success).toBe(false);
  });

  it('accepts the whole organisation with no projects listed', () => {
    expect(assignmentsSchema.safeParse({ project_access: 'ORGANISATION' }).success).toBe(true);
  });

  it('refuses the same programme twice', () => {
    const bad = assignmentsSchema.safeParse({
      project_access: 'ORGANISATION',
      programmes: [
        { survey_project_id: P1, project_role: 'GT_USER' },
        { survey_project_id: P1, project_role: 'QC_USER' },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('defaults a programme role rather than demanding one', () => {
    const ok = assignmentsSchema.parse({
      project_access: 'ORGANISATION', programmes: [{ survey_project_id: P1 }],
    });
    expect(ok.programmes[0].project_role).toBe('GT_USER');
  });
});

describe('describeAccess', () => {
  it('reads as a sentence, singular and plural', () => {
    expect(describeAccess('ORGANISATION', 0, 1))
      .toBe('Sees every project in the organisation, and 1 survey programme.');
    expect(describeAccess('ASSIGNED', 1, 0))
      .toBe('Sees 1 project, and no survey programmes.');
    expect(describeAccess('ASSIGNED', 3, 2))
      .toBe('Sees 3 projects, and 2 survey programmes.');
  });
});
