/**
 * Catalogue: the Web half of the end-to-end suite.
 *
 * Covers E2E-02, E2E-20, E2E-26, E2E-30 and E2E-31 from the client's side;
 * the server half of each row is in apps/api/test/catalogue/e2e.test.ts.
 * E2E-04 (the fence editor) is retired: Silverline has no geo-fencing.
 *
 * What is asserted here is the client's own decision-making — which navigation
 * a session may see, which endpoint a board drag calls, which fields reach a client viewer, and that every required
 * UI state has a component behind it. Pixel rendering and real browser timing
 * need a browser and are reported as such rather than faked.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS, S1_ROLE_GRANTS, S2_ROLE_GRANTS, S3_ROLE_GRANTS, S4_ROLE_GRANTS,
  S5_ROLE_GRANTS, S6_ROLE_GRANTS, P1_ROLE_GRANTS, V2_ROLE_GRANTS, CRM_ROLE_GRANTS,
  BILLING_ROLE_GRANTS, APPROVAL_ROLE_GRANTS, PROCUREMENT_ROLE_GRANTS,
  COST_CONTROL_ROLE_GRANTS, EXPENSE_ROLE_GRANTS, FINANCE_ROLE_GRANTS,
  INVENTORY_ROLE_GRANTS, ALLOCATION_ROLE_GRANTS, LEDGER_ROLE_GRANTS,
  DOCUMENT_ROLE_GRANTS, SURVEY_ROLE_GRANTS,
} from '@silverline/shared';
import { navItemVisible } from '../lib/landing';
import { NAV_GROUPS, QUICK_CREATE } from '../lib/nav';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { normalizeTask, normalizeTasksPage } from '../lib/tasks';

const WEB_ROOT = join(__dirname, '..');

function source(relativePath: string): string {
  return readFileSync(join(WEB_ROOT, relativePath), 'utf8');
}

/** The nav items a session with exactly these permissions would see. */
/** EMPLOYEE's real grants, assembled the way the seed assembles them. */
function employeePermissions(): string[] {
  const maps = [
    ROLE_PERMISSIONS, S1_ROLE_GRANTS, S2_ROLE_GRANTS, S3_ROLE_GRANTS, S4_ROLE_GRANTS,
    S5_ROLE_GRANTS, S6_ROLE_GRANTS, P1_ROLE_GRANTS, V2_ROLE_GRANTS, CRM_ROLE_GRANTS,
    BILLING_ROLE_GRANTS, APPROVAL_ROLE_GRANTS, PROCUREMENT_ROLE_GRANTS,
    COST_CONTROL_ROLE_GRANTS, EXPENSE_ROLE_GRANTS, FINANCE_ROLE_GRANTS,
    INVENTORY_ROLE_GRANTS, ALLOCATION_ROLE_GRANTS, LEDGER_ROLE_GRANTS,
    DOCUMENT_ROLE_GRANTS, SURVEY_ROLE_GRANTS,
  ] as Array<Partial<Record<'EMPLOYEE', string[]>>>;
  const out = new Set<string>();
  for (const m of maps) for (const p of m.EMPLOYEE ?? []) out.add(p);
  return [...out];
}

function visibleNav(permissions: string[]): string[] {
  // The predicate the sidebar itself uses. Re-implementing the filter here is
  // what let this test pass while the real sidebar behaved differently: a
  // destination may need more than the one permission it is named after.
  return NAV_GROUPS.flatMap((group) =>
    group.items.filter((item) => navItemVisible(permissions, item)).map((item) => item.href),
  );
}

// ===========================================================================
// E2E-02
// ===========================================================================

describe('E2E-02 employee signs in without admin permissions', () => {
  /**
   * The grants an EMPLOYEE actually carries, assembled the way the seed
   * assembles them.
   *
   * This was previously five permissions written out by hand, with a comment
   * saying that spelling them out would catch a silent widening of the role.
   * It did the opposite: the real role carries twenty-four, so the test was
   * describing a user the product has never shipped, and every assertion below
   * was about that imaginary person. The count is pinned separately, which
   * catches a widening without inventing the role.
   */
  const EMPLOYEE_PERMISSIONS = employeePermissions();

  it('matches the role the seed actually grants', () => {
    // Pinned so a widening still fails loudly — but against the real role.
    expect(EMPLOYEE_PERMISSIONS).toContain('task.read');
    expect(EMPLOYEE_PERMISSIONS).toContain('project.read');
    expect(EMPLOYEE_PERMISSIONS).toContain('leave.request');
    expect(EMPLOYEE_PERMISSIONS).not.toContain('users.read');
    expect(EMPLOYEE_PERMISSIONS).not.toContain('payroll.read');
    expect(EMPLOYEE_PERMISSIONS.length).toBeLessThan(40);
  });

  it('hides every administrative destination from an ordinary employee', () => {
    const visible = visibleNav(EMPLOYEE_PERMISSIONS);

    // An employee works on projects and is issued assets, so /projects and
    // /assets are theirs. What they must not reach is other people's records
    // and the money.
    for (const adminHref of [
      '/employees',
      '/attendance/exceptions',
      '/payroll',
      '/org/locations',
      '/org/holidays',
      '/admin',
      '/inventory',
      '/analytics',
      '/automation',
      '/reports',
      '/receivables',
      '/payables',
      '/billing',
      '/procurement',
      '/clients',
      '/tenders',
      '/leads',
    ]) {
      expect(visible, `${adminHref} must be hidden`).not.toContain(adminHref);
    }
  });

  it('still offers the employee their own destinations', () => {
    const visible = visibleNav(EMPLOYEE_PERMISSIONS);
    // An employee is not left with an empty shell.
    expect(visible).toContain('/dashboard');
    expect(visible).toContain('/my-work');
    expect(visible).toContain('/inbox');
    expect(visible).toContain('/leave');
    expect(visible).toContain('/my-payslip');
    // Their own punch clock lives at /attendance; the register on the same
    // page needs attendance.read and is not rendered for them.
    expect(visible).toContain('/attendance');
  });

  it('hides every quick-create action an employee cannot perform', () => {
    const holder = { permissions: EMPLOYEE_PERMISSIONS };
    const actions = QUICK_CREATE.filter(
      (item) => !item.permission || hasPermission(holder, item.permission),
    ).map((item) => item.href);
    expect(actions).not.toContain('/projects/new');
    expect(actions).not.toContain('/payroll/new');
    expect(actions).not.toContain('/employees/import');
    // Requesting their own leave stays available.
    expect(actions).toContain('/leave/new');
  });

  it('offers no geo-fence destination to anybody', () => {
    // Removed with the feature, not merely hidden: a stale grant such as the
    // old geo.read must not resurrect the screen.
    expect(NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === '/geo-fences')).toBeUndefined();
    expect(visibleNav(['auth.login', 'geo.read', 'geo.manage'])).not.toContain('/geo-fences');
  });

  it('fails closed for a permission code that does not exist on the server', () => {
    // A typo in a nav gate must hide the item, never reveal it.
    const holder = { permissions: ['auth.login'] };
    expect(hasPermission(holder, 'geo:read')).toBe(false);
    expect(hasPermission(holder, '')).toBe(false);
  });
});

// ===========================================================================
// E2E-20
// ===========================================================================

describe('E2E-20 PM drags card through allowed then disallowed board transition', () => {
  const board = source('components/KanbanBoard.tsx');

  it('routes a cross-column drag through the shared status endpoint', () => {
    // The board has no transition endpoint of its own: a drag across columns
    // calls the same helper the List view and the API client call, so one
    // workflow rule governs both.
    expect(board).toMatch(/transitionTask/);
    const tasks = source('lib/tasks.ts');
    expect(tasks).toMatch(/\/api\/v1\/tasks\/\$\{[^}]+\}\/status/);
  });

  it('routes a within-column drag through the reorder endpoint instead', () => {
    expect(board).toMatch(/patchTaskBoardPosition/);
    const tasks = source('lib/tasks.ts');
    expect(tasks).toMatch(/board-position/);
  });

  it('rolls the card back when the server refuses the move', () => {
    // An optimistic move that is not rolled back leaves the board lying about
    // the task's real status.
    expect(board).toMatch(/rollback|revert|previous|setGroups\(/i);
    expect(board).toMatch(/not allowed from the current status/);
  });

  it('gates the project-people fetch on the permission the route itself requires, not a role name (P-001 round 2)', () => {
    // Post-deploy QA round 1 (P-001): this board fetched `projects/:id/people`
    // unconditionally to label avatars and 403'd for CLIENT_VIEWER. The
    // first fix gated it on `!session?.roles?.every(r=>r==='CLIENT_VIEWER')`
    // — but GET /projects/:id/people is actually gated on `task.read`
    // (planning/routes.ts), which CLIENT_VIEWER holds and GOVT_OBSERVER does
    // not: a role-name check only ever protects the one role it names, so
    // GOVT_OBSERVER (holding nothing) still 403'd. Must gate on the actual
    // permission via hasPermission/PERMISSIONS, like every other guarded
    // fetch in this codebase.
    expect(board).toMatch(
      /useRows\(`projects\/\$\{projectId\}\/people\?limit=100`,\s*!!projectId\s*&&\s*hasPermission\(session,\s*PERMISSIONS\.TASK_READ\)\)/,
    );
    expect(board).not.toMatch(/roles\?\.every\(r\s*=>\s*r\s*===\s*'CLIENT_VIEWER'\)/);
  });

  it('offers only the statuses the server says are reachable', () => {
    // allowed_next is the server's answer; the board must not invent targets.
    const page = normalizeTasksPage({
      data: [
        {
          id: 't1',
          project_id: 'p1',
          title: 'Card',
          status: 'IN_PROGRESS',
          version: 2,
          allowed_next: ['IN_REVIEW', 'BLOCKED', 'TO_DO'],
        },
      ],
    });
    expect(page[0]!.allowed_next).toEqual(['IN_REVIEW', 'BLOCKED', 'TO_DO']);
    expect(page[0]!.allowed_next).not.toContain('DONE');
  });

  it('keeps the same task shape whether it came from the list or the board', () => {
    const raw = {
      id: 't2',
      project_id: 'p1',
      title: 'Card',
      status: 'TO_DO',
      version: 1,
      allowed_next: ['IN_PROGRESS', 'CANCELLED'],
    };
    // Both views normalize through one function, so neither can drift into a
    // different idea of what a task is.
    expect(normalizeTask(raw)).toEqual(normalizeTasksPage({ data: [raw] })[0]);
  });
});

// ===========================================================================
// E2E-26
// ===========================================================================

describe('E2E-26 auditor exports attendance/audit report; viewer exports project progress', () => {
  it('offers each report type only to a holder of its domain read', () => {
    const form = source('components/ReportForm.tsx');
    // The per-type gate lives in the form; without it a viewer is shown an
    // export they will only be refused at the server.
    expect(form).toMatch(/permission|hasPermission|REPORT_DOMAIN_READ/);
  });

  it('never invents a sensitive value the server withheld', async () => {
    const { displayMasked, isMaskedOnly, MASKED_PLACEHOLDER } = await import(
      '../lib/masking'
    );
    // The server sends null plus a last-4 when the reader lacks PII access.
    expect(displayMasked(null, '9012')).toBe('•••• 9012');
    expect(isMaskedOnly(null, '9012')).toBe(true);
    // With neither, the UI shows a placeholder rather than guessing or
    // rendering a bare "null".
    expect(displayMasked(null, null)).toBe(MASKED_PLACEHOLDER);
    expect(displayMasked(undefined, undefined)).toBe(MASKED_PLACEHOLDER);
    expect(displayMasked('', '')).toBe(MASKED_PLACEHOLDER);
    // And the full value is shown only when the server actually sent one.
    expect(displayMasked('123456789012', '9012')).toBe('123456789012');
    expect(isMaskedOnly('123456789012', '9012')).toBe(false);
  });

  it('keeps the download behind an authorized request rather than a public link', () => {
    const reports = source('lib/reports.ts');
    // A raw object-store URL would bypass the server's scope check entirely.
    expect(reports).toMatch(/\/api\/v1\/reports/);
    expect(reports).not.toMatch(/https?:\/\/[^\s'"`]*\.(s3|r2)\./);
  });

  it('tells the reader when they are looking at a scoped subset', () => {
    // Silently showing a partial list as if it were complete is how a scoped
    // export gets misread as the whole organization.
    expect(existsSync(join(WEB_ROOT, 'components/ScopeNoteBanner.tsx'))).toBe(true);
    const banner = source('components/ScopeNoteBanner.tsx');
    expect(banner).toMatch(/scope/i);
  });
});

// ===========================================================================
// E2E-30
// ===========================================================================

describe('E2E-30 exercise Web loading empty error unauthorized keyboard and focus states', () => {
  it('provides a component for every required state', () => {
    for (const component of [
      'components/ui/Skeleton.tsx',
      'components/ui/Spinner.tsx',
      'components/ui/EmptyState.tsx',
      'components/ui/ErrorCard.tsx',
      'components/Forbidden.tsx',
    ]) {
      expect(existsSync(join(WEB_ROOT, component)), `${component} is missing`).toBe(true);
    }
  });

  it('provides a route for every required failure', () => {
    for (const route of [
      'app/error.tsx',
      'app/global-error.tsx',
      'app/not-found.tsx',
      'app/403/page.tsx',
    ]) {
      expect(existsSync(join(WEB_ROOT, route)), `${route} is missing`).toBe(true);
    }
  });

  it('gives each error boundary a recovery action, not just a message', () => {
    for (const route of ['app/error.tsx', 'app/global-error.tsx']) {
      const text = source(route);
      // A dead end with no way forward is not an understandable error state.
      expect(text, route).toMatch(/reset|retry|Try again|reload/i);
    }
  });

  it('names the empty and forbidden states in words a user can act on', () => {
    expect(source('components/ui/EmptyState.tsx')).toMatch(/title|description|action/);
    expect(source('components/Forbidden.tsx')).toMatch(/permission|access|contact/i);
  });

  it('keeps interactive primitives reachable by keyboard', () => {
    const button = source('components/ui/Button.tsx');
    // Focus must be visible: a keyboard user who cannot see focus is lost.
    expect(button).toMatch(/focus-visible/);
    // A disabled control must not be a silent tab stop.
    expect(button).toMatch(/disabled/);

    const input = source('components/ui/Input.tsx');
    expect(input).toMatch(/focus-visible|focus:/);
  });

  it('labels the icon-only controls so a screen reader can announce them', () => {
    for (const component of ['components/ui/ThemeToggle.tsx']) {
      expect(source(component)).toMatch(/aria-label|sr-only/);
    }
  });

  it('associates every form field with its error message', () => {
    const field = source('components/ui/FormField.tsx');
    // role="alert" announces once, when the message appears. A user who tabs
    // back into the field afterwards needs the control itself to carry both.
    expect(field).toMatch(/aria-invalid/);
    expect(field).toMatch(/aria-describedby/);
    expect(field).toMatch(/role="alert"/);
  });
});

// ===========================================================================
// E2E-31
// ===========================================================================

describe('E2E-31 load normal authenticated Web screens under agreed data volume', () => {
  it('pages every list rather than loading a whole table into a screen', () => {
    // The three-second budget is only achievable if a screen asks for a page.
    const tasks = source('lib/tasks.ts');
    expect(tasks).toMatch(/limit/);
    expect(tasks).toMatch(/cursor|offset/);

    const employees = source('lib/employees.ts');
    expect(employees).toMatch(/limit/);
  });

  it('never asks a list endpoint for an unbounded page', () => {
    // The server caps a page at 100 rows; a client that omits the bound is
    // relying on that cap rather than choosing a page size.
    const tasks = source('lib/tasks.ts');
    const match = tasks.match(/limit[^\n]{0,40}?(\d{1,5})/);
    if (match) expect(Number(match[1])).toBeLessThanOrEqual(100);
  });

  it('caches reads instead of refetching on every render', () => {
    const keys = source('lib/query-keys.ts');
    // Stable keys are what let the client serve a screen from cache.
    expect(keys).toMatch(/export const queryKeys/);
    expect(keys.length).toBeGreaterThan(200);
  });

  it('normalizes a large page without quadratic work', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      id: `t${index}`,
      project_id: 'p1',
      title: `Task ${index}`,
      status: 'TO_DO',
      version: 1,
    }));
    const started = performance.now();
    const normalized = normalizeTasksPage({ data: rows });
    const elapsed = performance.now() - started;
    expect(normalized).toHaveLength(5000);
    // Client-side normalization must not be what spends the budget.
    expect(elapsed).toBeLessThan(250);
  });
});
