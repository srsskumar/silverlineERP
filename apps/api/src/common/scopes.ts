import type { Pool } from "pg";

/**
 * RBAC scope resolution + SQL filters (PRD §4.1).
 *
 * `user_roles` carries a nullable `(scope_type, scope_id)` per assignment.
 * `resolveScopes` is pure (unit-tested in test/rbac.test.ts); the `*Clause`
 * builders below turn a resolved scope into an extra `WHERE` fragment for
 * the two scope-filtered reads (GET /employees, GET /tasks).
 *
 * Scope types:
 * - `district` | `mandal` | `village` — org_units id. Ancestry is resolved
 *   in JS over the org's unit tree (villages roll up to mandal → district),
 *   so partially-filled employee FKs still match.
 * - `team` — scope_id is the MANAGER's employee id; matches the
 *   `reports_to` subtree (root included).
 * - `project` — org project id; employees match via tasks assigned (through
 *   the assignee's linked employee) to that project, tasks match directly.
 */

export interface ScopeAssignment {
  scope_type: string | null;
  scope_id: string | null;
}

export interface ResolvedScopes {
  /** Virtual scope for the baseline employee role; contains user IDs. */
  selfUsers?:string[];
  /**
   * True when ANY assignment is null-scoped (missing type or id): the user
   * sees everything their permissions allow (permission-gate only).
   */
  global: boolean;
  districts: string[];
  mandals: string[];
  villages: string[];
  /** Manager employee ids (`team` scope). */
  teams: string[];
  projects: string[];
}

function emptyResolved(global: boolean): ResolvedScopes {
  return {
    global,
    districts: [],
    mandals: [],
    villages: [],
    teams: [],
    projects: [],
  };
}

function pushUnique(target: string[], id: string | null): void {
  if (id && !target.includes(id)) {
    target.push(id);
  }
}

/**
 * Collects a user's `user_roles` assignments into scope buckets. A
 * null-scope assignment (null type OR null id) short-circuits to global.
 * Unknown scope types are ignored (fail closed: a user left with no usable
 * scope sees nothing on scope-filtered reads).
 */
export function resolveScopes(
  assignments: readonly ScopeAssignment[],
): ResolvedScopes {
  // No assignments (user holds no roles): nothing to restrict by — the
  // permission gates still deny everything, so this is not fail-open.
  if (assignments.length === 0) {
    return emptyResolved(true);
  }
  const out = emptyResolved(false);
  for (const a of assignments) {
    if (!a.scope_type || !a.scope_id) {
      return emptyResolved(true);
    }
    switch (a.scope_type) {
      case "self":
        pushUnique(out.selfUsers??= [],a.scope_id);break;
      case "district":
        pushUnique(out.districts, a.scope_id);
        break;
      case "mandal":
        pushUnique(out.mandals, a.scope_id);
        break;
      case "village":
        pushUnique(out.villages, a.scope_id);
        break;
      case "team":
        pushUnique(out.teams, a.scope_id);
        break;
      case "project":
        pushUnique(out.projects, a.scope_id);
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Org-unit tree expansion (pure over a preloaded unit list)
// ---------------------------------------------------------------------------

export interface OrgUnitNode {
  id: string;
  type: string;
  parent_id: string | null;
}

/**
 * Expands scoped geo units to full id sets:
 * - districts: scoped districts + districts above scoped mandals/villages.
 * - mandals: scoped mandals + mandals below scoped districts + mandals
 *   above scoped villages.
 * - villages: scoped villages + villages below scoped districts/mandals.
 * Unknown ids (deleted units, other orgs) contribute nothing.
 */
export function expandGeoScope(
  units: readonly OrgUnitNode[],
  scopes: Pick<ResolvedScopes, "districts" | "mandals" | "villages">,
): { districts: string[]; mandals: string[]; villages: string[] } {
  const byId = new Map(units.map((u) => [u.id, u]));
  const children = new Map<string, OrgUnitNode[]>();
  for (const u of units) {
    if (u.parent_id) {
      const list = children.get(u.parent_id) ?? [];
      list.push(u);
      children.set(u.parent_id, list);
    }
  }
  const ancestors = (id: string): OrgUnitNode[] => {
    const chain: OrgUnitNode[] = [];
    const seen = new Set<string>([id]);
    let cur = byId.get(id)?.parent_id ?? null;
    for (let steps = 0; steps < 100 && cur; steps += 1) {
      if (seen.has(cur)) {
        break;
      }
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) {
        break;
      }
      chain.push(node);
      cur = node.parent_id;
    }
    return chain;
  };
  const descendantsOfType = (id: string, type: string): string[] => {
    const found: string[] = [];
    const queue: string[] = [id];
    const seen = new Set<string>([id]);
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      for (const child of children.get(cur) ?? []) {
        if (seen.has(child.id)) {
          continue;
        }
        seen.add(child.id);
        if (child.type === type) {
          found.push(child.id);
        }
        queue.push(child.id);
      }
    }
    return found;
  };

  const districts = new Set<string>();
  const mandals = new Set<string>();
  const villages = new Set<string>();
  const ofType = (nodes: OrgUnitNode[], type: string): string[] =>
    nodes.filter((n) => n.type === type).map((n) => n.id);

  for (const id of scopes.districts) {
    if (!byId.has(id)) {
      continue;
    }
    districts.add(id);
    for (const m of descendantsOfType(id, "mandal")) {
      mandals.add(m);
    }
    for (const v of descendantsOfType(id, "village")) {
      villages.add(v);
    }
  }
  for (const id of scopes.mandals) {
    if (!byId.has(id)) {
      continue;
    }
    mandals.add(id);
    for (const d of ofType(ancestors(id), "district")) {
      districts.add(d);
    }
    for (const v of descendantsOfType(id, "village")) {
      villages.add(v);
    }
  }
  for (const id of scopes.villages) {
    if (!byId.has(id)) {
      continue;
    }
    villages.add(id);
    for (const m of ofType(ancestors(id), "mandal")) {
      mandals.add(m);
    }
    for (const d of ofType(ancestors(id), "district")) {
      districts.add(d);
    }
  }
  return {
    districts: [...districts],
    mandals: [...mandals],
    villages: [...villages],
  };
}

/** Villages whose ancestry falls in scope (for task `village_id` matching). */
export function villagesInScope(
  units: readonly OrgUnitNode[],
  scopes: Pick<ResolvedScopes, "districts" | "mandals" | "villages">,
): string[] {
  return expandGeoScope(units, scopes).villages;
}

async function loadUnits(pool: Pool, orgId: string): Promise<OrgUnitNode[]> {
  const res = await pool.query(
    "SELECT id, type, parent_id FROM org_units WHERE org_id = $1",
    [orgId],
  );
  return res.rows as OrgUnitNode[];
}

/** Recursive `reports_to` subtree (root included) for manager employee ids. */
function teamSubtreeClause(
  idExpr: string,
  orgIdParam: string,
  rootsParam: string,
): string {
  return `${idExpr} IN (
    WITH RECURSIVE scope_sub(id) AS (
      SELECT id FROM employees WHERE org_id = ${orgIdParam} AND id = ANY(${rootsParam}::uuid[])
      UNION
      SELECT e.id FROM employees e
      JOIN scope_sub s ON e.reports_to = s.id
      WHERE e.org_id = ${orgIdParam}
    )
    SELECT id FROM scope_sub
  )`;
}

/**
 * Extra `WHERE` fragment for GET /employees. `values` is the route's live
 * parameter array (placeholders are appended in order). Returns `"1 = 0"`
 * (fail closed) when the user is scoped but holds no usable scope.
 */
export async function employeeScopeClause(
  pool: Pool,
  orgId: string,
  scopes: ResolvedScopes,
  values: unknown[],
): Promise<string> {
  const ors: string[] = [];
  if(scopes.selfUsers?.length){values.push(scopes.selfUsers);ors.push(`employees.id IN(SELECT employee_id FROM users WHERE id=ANY($${values.length}::uuid[]))`);}
  if (
    scopes.districts.length > 0 ||
    scopes.mandals.length > 0 ||
    scopes.villages.length > 0
  ) {
    const exp = expandGeoScope(await loadUnits(pool, orgId), scopes);
    values.push(exp.districts, exp.mandals, exp.villages);
    const k = values.length;
    // Coarsest-match-wins: a village scope must NOT fan out to the whole
    // district via employees' district FK. Match the finest FK the employee
    // carries; fall back to coarser FKs only when finer ones are absent
    // (partial master data still matches).
    ors.push(
      `(employees.village_id = ANY($${k}::uuid[]) OR ` +
        `(employees.village_id IS NULL AND employees.mandal_id = ANY($${k - 1}::uuid[])) OR ` +
        `(employees.village_id IS NULL AND employees.mandal_id IS NULL AND employees.district_id = ANY($${k - 2}::uuid[])))`,
    );
  }
  if (scopes.teams.length > 0) {
    values.push(orgId, scopes.teams);
    const k = values.length;
    ors.push(teamSubtreeClause("employees.id", `$${k - 1}`, `$${k}`));
  }
  if (scopes.projects.length > 0) {
    values.push(orgId, scopes.projects);
    const k = values.length;
    ors.push(
      `EXISTS (SELECT 1 FROM tasks t JOIN users u ON u.id = t.assignee_id ` +
        `WHERE u.employee_id = employees.id AND t.org_id = $${k - 1} AND ` +
        `t.project_id = ANY($${k}::uuid[]))`,
    );
  }
  if (ors.length === 0) {
    return "1 = 0";
  }
  return `(${ors.join(" OR ")})`;
}

/**
 * Extra `WHERE` fragment for GET /tasks. Tasks carry `village_id`, so geo
 * scopes match villages in scope (ancestry resolved in JS); tasks with a
 * NULL village never match a geo scope. Team scopes match tasks assigned
 * to linked users of the subtree.
 */
export async function taskScopeClause(
  pool: Pool,
  orgId: string,
  scopes: ResolvedScopes,
  values: unknown[],
): Promise<string> {
  const ors: string[] = [];
  if(scopes.selfUsers?.length){
  /*
   * What "their own work" actually covers (§note 17).
   *
   * The task assigned to them, a task they were put on to help with, and
   * every task on a project they manage. Read as the assignee alone, a
   * project manager restricted to their own work would see the one task
   * somebody happened to assign them and none of the project they run —
   * which is not a rule anybody meant.
   */
  values.push(scopes.selfUsers);
  const self=values.length;
  ors.push(`assignee_id=ANY($${self}::uuid[])`);
  ors.push(`id IN (SELECT c.task_id FROM task_collaborators c WHERE c.user_id=ANY($${self}::uuid[]))`);
  // Being mentioned is being involved. Without this, naming somebody in a
  // comment tells them about a task they are then refused sight of, which
  // makes the mention worse than saying nothing.
  ors.push(`id IN (SELECT cm.task_id FROM mentions m JOIN comments cm ON cm.id=m.comment_id`
   + ` WHERE m.mentioned_user_id=ANY($${self}::uuid[]))`);
  ors.push(`project_id IN (SELECT p.id FROM projects p WHERE p.project_manager_id=ANY($${self}::uuid[]))`);
 }
  if (scopes.projects.length > 0) {
    values.push(scopes.projects);
    ors.push(`project_id = ANY($${values.length}::uuid[])`);
  }
  if (
    scopes.districts.length > 0 ||
    scopes.mandals.length > 0 ||
    scopes.villages.length > 0
  ) {
    const villageIds = villagesInScope(await loadUnits(pool, orgId), scopes);
    values.push(villageIds);
    ors.push(`village_id = ANY($${values.length}::uuid[])`);
  }
  if (scopes.teams.length > 0) {
    values.push(orgId, scopes.teams);
    const k = values.length;
    ors.push(
      `assignee_id IN (SELECT u.id FROM users u WHERE u.employee_id IN (` +
        `WITH RECURSIVE scope_sub(id) AS (` +
        `SELECT id FROM employees WHERE org_id = $${k - 1} AND id = ANY($${k}::uuid[]) ` +
        `UNION ` +
        `SELECT e.id FROM employees e JOIN scope_sub s ON e.reports_to = s.id WHERE e.org_id = $${k - 1}` +
        `) SELECT id FROM scope_sub))`,
    );
  }
  if (ors.length === 0) {
    return "1 = 0";
  }
  return `(${ors.join(" OR ")})`;
}
