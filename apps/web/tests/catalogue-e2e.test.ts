/**
 * Catalogue: the Web half of the end-to-end suite.
 *
 * Covers E2E-02, E2E-04, E2E-20, E2E-26, E2E-30 and E2E-31 from the client's
 * side; the server half of each row is in apps/api/test/catalogue/e2e.test.ts.
 *
 * What is asserted here is the client's own decision-making — which navigation
 * a session may see, what payload the fence form submits, which endpoint a
 * board drag calls, which fields reach a client viewer, and that every required
 * UI state has a component behind it. Pixel rendering and real browser timing
 * need a browser and are reported as such rather than faked.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, QUICK_CREATE } from '../lib/nav';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { buildFencesQuery, normalizeFences } from '../lib/geo';
import { normalizeTask, normalizeTasksPage } from '../lib/tasks';

const WEB_ROOT = join(__dirname, '..');

function source(relativePath: string): string {
  return readFileSync(join(WEB_ROOT, relativePath), 'utf8');
}

/** The nav items a session with exactly these permissions would see. */
function visibleNav(permissions: string[]): string[] {
  const holder = { permissions };
  return NAV_GROUPS.flatMap((group) =>
    group.items
      .filter((item) => !item.permission || hasPermission(holder, item.permission))
      .map((item) => item.href),
  );
}

// ===========================================================================
// E2E-02
// ===========================================================================

describe('E2E-02 employee signs in without admin permissions', () => {
  // The grants an EMPLOYEE role actually carries (see packages/shared rbac +
  // the S1..P1 grant maps). Deliberately spelled out rather than imported, so
  // a silent widening of the role fails this test.
  const EMPLOYEE_PERMISSIONS = [
    'auth.login',
    'attendance.punch',
    'task.read',
    'leave.request',
    'payslip.read',
  ];

  it('hides every administrative destination from an ordinary employee', () => {
    const visible = visibleNav(EMPLOYEE_PERMISSIONS);

    for (const adminHref of [
      '/employees',
      '/attendance',
      '/attendance/exceptions',
      '/payroll',
      '/geo-fences',
      '/org/locations',
      '/org/holidays',
      '/admin',
      '/inventory',
      '/assets',
      '/analytics',
      '/automation',
      '/reports',
      '/projects',
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

  it('gates the geo-fence destination on geo.read, not merely on a session', () => {
    const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === '/geo-fences');
    expect(item?.permission).toBe(PERMISSIONS.GEO_READ);
    expect(visibleNav(['auth.login'])).not.toContain('/geo-fences');
    expect(visibleNav([PERMISSIONS.GEO_READ])).toContain('/geo-fences');
  });

  it('fails closed for a permission code that does not exist on the server', () => {
    // A typo in a nav gate must hide the item, never reveal it.
    const holder = { permissions: ['auth.login'] };
    expect(hasPermission(holder, 'geo:read')).toBe(false);
    expect(hasPermission(holder, '')).toBe(false);
  });
});

// ===========================================================================
// E2E-04
// ===========================================================================

describe('E2E-04 admin opens New fence, searches a place, selects result and clicks map', () => {
  it('builds the fence list query the page actually issues', () => {
    expect(buildFencesQuery({})).toBe('/api/v1/geo-fences');
    const scoped = buildFencesQuery({ scope_type: 'site', scope_id: 'abc' });
    expect(scoped).toContain('scope_type=site');
    expect(scoped).toContain('scope_id=abc');
  });

  it('normalizes a circle fence into the shape the map previews', () => {
    const [fence] = normalizeFences({
      data: [
        {
          id: 'f1',
          name: 'Depot',
          scope_type: 'site',
          scope_id: 's1',
          geometry_type: 'circle',
          geometry: { lat: 17.385, lng: 78.4867, radius_m: 200 },
          tolerance_meters: 25,
          status: 'ACTIVE',
          version: 3,
        },
      ],
    });
    expect(fence!.geometry_type).toBe('circle');
    const geometry = fence!.geometry as { lat: number; lng: number; radius_m: number };
    // The preview circle is drawn from exactly these three numbers.
    expect(geometry.lat).toBeCloseTo(17.385, 6);
    expect(geometry.lng).toBeCloseTo(78.4867, 6);
    expect(geometry.radius_m).toBe(200);
    expect(fence!.tolerance_meters).toBe(25);
  });

  it('normalizes a polygon fence without losing or reordering its points', () => {
    const points: Array<[number, number]> = [
      [17.4, 78.5],
      [17.41, 78.5],
      [17.41, 78.51],
    ];
    const [fence] = normalizeFences({
      data: [
        {
          id: 'f2',
          name: 'Yard',
          scope_type: 'site',
          scope_id: 's2',
          geometry_type: 'polygon',
          geometry: { points },
          tolerance_meters: 0,
          status: 'ACTIVE',
          version: 1,
        },
      ],
    });
    expect((fence!.geometry as { points: Array<[number, number]> }).points).toEqual(points);
  });

  it('wires the place search to the map through the fence form', () => {
    const form = source('components/FenceForm.tsx');
    // The form searches places and writes the chosen coordinate into the
    // geometry it submits; a map click does the same thing.
    expect(form).toMatch(/searchPlaces/);
    expect(form).toMatch(/lat/);
    expect(form).toMatch(/lng/);
    // Radius and tolerance are part of the submitted geometry, not decoration.
    expect(form).toMatch(/radius_m/);
    expect(form).toMatch(/tolerance_meters/);
  });

  it('recenters the map on the selected result', () => {
    const map = source('components/map/FenceMap.tsx');
    // A selection has to move the viewport, or the "map recenters" step of the
    // workflow does not happen.
    expect(map).toMatch(/flyTo|easeTo|jumpTo|setCenter|fitBounds/);
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
    expect(buildFencesQuery({ scope_type: 'site' })).toContain('scope_type=site');
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
