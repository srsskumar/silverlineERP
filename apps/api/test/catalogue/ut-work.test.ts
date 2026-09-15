/**
 * Catalogue: Projects, tasks, boards, cycles and automation (UT-WORK-01..12).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeSlaStatus } from "@silverline/shared";
import { runJobs } from "../../src/modules/automation/worker.js";
import {
  JWT_SECRET,
  buildWorld,
  createActiveEmployee,
  createUser,
  idem,
  ifMatch,
  loginAs,
  post,
  uniq,
  workDate,
  type CatalogueWorld,
  type Headers,
} from "./fixture.js";

let w: CatalogueWorld;

beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

interface ErrorBody {
  code: string;
  message: string;
  allowed_next?: string[];
  blockers?: unknown[];
  open_count?: number;
  field_errors?: Array<{ field: string; message: string }>;
}

/** A project of its own, so a test's tasks never collide with another's. */
async function project(name = "Work probe"): Promise<string> {
  const id = await post(w.app, w.admin, "/api/v1/projects", {
    workspace_id: w.workspaceId,
    project_type_id: w.projectTypeId,
    code: `WK${uniq().toUpperCase().slice(-7)}`,
    name,
  });
  const current = await w.app.inject({
    method: "GET",
    url: `/api/v1/projects/${id}`,
    headers: w.admin,
  });
  await w.app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${id}`,
    headers: {
      ...w.admin,
      "if-match": String((current.json() as { version: number }).version),
      ...idem(),
    },
    payload: { status: "ACTIVE" },
  });
  return id;
}

async function task(
  projectId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  return post(w.app, w.admin, "/api/v1/tasks", {
    project_id: projectId,
    title: `Task ${uniq()}`,
    ...over,
  });
}

async function addDependency(
  successorId: string,
  predecessorId: string,
  headers: Headers = w.admin,
) {
  return w.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${successorId}/dependencies`,
    headers: { ...headers, ...idem() },
    payload: { predecessor_id: predecessorId, dependency_type: "FINISH_TO_START" },
  });
}

async function setStatus(
  taskId: string,
  status: string,
  extra: Record<string, unknown> = {},
  headers: Headers = w.admin,
) {
  return w.app.inject({
    method: "PATCH",
    url: `/api/v1/tasks/${taskId}/status`,
    headers: { ...headers, ...(await ifMatch(w, "tasks", taskId)), ...idem() },
    payload: { status, ...extra },
  });
}

/**
 * Runs the worker until it has nothing left to do.
 *
 * Every task creation emits its own domain event, and the worker takes 25 per
 * pass, so a single call is not enough to reach an event this file queued after
 * dozens of others.
 */
async function drainJobs(maxPasses = 20): Promise<void> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const { events } = await runJobs(w.app, w.pool, JWT_SECRET);
    if (events === 0) return;
  }
}

/** Marks one event unprocessed, as a crashed worker would leave it. */
async function replayEvent(eventId: string): Promise<void> {
  await w.pool.query("UPDATE domain_events SET processed_at = NULL WHERE id = $1", [eventId]);
}

describe("UT-WORK-01 add dependency that creates direct or transitive cycle", () => {
  it("rejects a task depending on itself", async () => {
    const p = await project();
    const a = await task(p);
    const res = await addDependency(a, a);
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("SELF_DEPENDENCY");
  });

  it("rejects a direct two-task cycle", async () => {
    const p = await project();
    const a = await task(p);
    const b = await task(p);
    expect((await addDependency(b, a)).statusCode).toBe(201);

    const res = await addDependency(a, b);
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("DEPENDENCY_CYCLE");
  });

  it("rejects a transitive cycle three tasks deep", async () => {
    const p = await project();
    const a = await task(p);
    const b = await task(p);
    const c = await task(p);
    expect((await addDependency(b, a)).statusCode).toBe(201);
    expect((await addDependency(c, b)).statusCode).toBe(201);

    // a → b → c, so making a depend on c closes the loop.
    const res = await addDependency(a, c);
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("DEPENDENCY_CYCLE");
  });

  it("leaves the graph unchanged after a rejected edge", async () => {
    const p = await project();
    const a = await task(p);
    const b = await task(p);
    await addDependency(b, a);
    const before = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM task_dependencies WHERE successor_id = ANY($1::uuid[])",
      [[a, b]],
    );

    await addDependency(a, b);

    const after = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM task_dependencies WHERE successor_id = ANY($1::uuid[])",
      [[a, b]],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("rejects a dependency that crosses projects", async () => {
    const p1 = await project();
    const p2 = await project();
    const res = await addDependency(await task(p1), await task(p2));
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("INVALID_DEPENDENCY");
  });

  it("accepts an acyclic diamond", async () => {
    const p = await project();
    const root = await task(p);
    const left = await task(p);
    const right = await task(p);
    const join = await task(p);
    expect((await addDependency(left, root)).statusCode).toBe(201);
    expect((await addDependency(right, root)).statusCode).toBe(201);
    expect((await addDependency(join, left)).statusCode).toBe(201);
    // Two paths to the same node is not a cycle.
    expect((await addDependency(join, right)).statusCode).toBe(201);
  });
});

describe("UT-WORK-02 start successor before predecessor satisfies rule", () => {
  async function blockedPair() {
    const p = await project();
    const predecessor = await task(p);
    const successor = await task(p);
    expect((await addDependency(successor, predecessor)).statusCode).toBe(201);
    return { predecessor, successor };
  }

  it("blocks the successor while the predecessor is unfinished", async () => {
    const { successor } = await blockedPair();
    const res = await setStatus(successor, "IN_PROGRESS");
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("DEPENDENCY_BLOCKED");

    const row = await w.pool.query("SELECT status FROM tasks WHERE id = $1", [successor]);
    expect(row.rows[0].status).toBe("TO_DO");
  });

  it("requires a reason with the override, not just the flag", async () => {
    const { successor } = await blockedPair();
    const res = await setStatus(successor, "IN_PROGRESS", { override: true });
    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrorBody;
    expect(body.field_errors?.[0]?.field).toBe("override_reason");
  });

  it("allows an authorized, audited override", async () => {
    const { successor } = await blockedPair();
    const reason = "Site engineer confirmed the foundation is cured";
    const res = await setStatus(successor, "IN_PROGRESS", {
      override: true,
      override_reason: reason,
    });
    expect(res.statusCode).toBe(200);

    const audit = await w.pool.query(
      "SELECT action, reason, actor_id FROM audit_events WHERE entity_id = $1 AND action = 'task.status.override'",
      [successor],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].reason).toBe(reason);
    expect(audit.rows[0].actor_id).toBe(w.adminId);
  });

  it("unblocks the successor once the predecessor is done", async () => {
    const { predecessor, successor } = await blockedPair();
    expect((await setStatus(predecessor, "IN_PROGRESS")).statusCode).toBe(200);
    expect((await setStatus(predecessor, "IN_REVIEW")).statusCode).toBe(200);
    expect((await setStatus(predecessor, "DONE")).statusCode).toBe(200);

    const res = await setStatus(successor, "IN_PROGRESS");
    expect(res.statusCode).toBe(200);
  });

  it("names the blocking predecessor on the task detail", async () => {
    const { predecessor, successor } = await blockedPair();
    const detail = await w.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${successor}`,
      headers: w.admin,
    });
    const body = detail.json() as {
      dependencies: { blocked_by: Array<{ id: string }> };
    };
    expect(body.dependencies.blocked_by.map((b) => b.id)).toContain(predecessor);
  });
});

describe("UT-WORK-03 apply valid and invalid workflow transitions", () => {
  it("walks the configured happy path", async () => {
    const p = await project();
    const t = await task(p);
    for (const status of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
      const res = await setStatus(t, status);
      expect(res.statusCode, status).toBe(200);
    }
  });

  it("rejects an invalid edge and returns the allowed next statuses", async () => {
    const p = await project();
    const t = await task(p);
    // TO_DO cannot jump straight to DONE.
    const res = await setStatus(t, "DONE");
    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrorBody;
    expect(body.code).toBe("INVALID_TRANSITION");
    // The error is actionable: it says where the task *can* go.
    expect(body.allowed_next).toEqual(expect.arrayContaining(["IN_PROGRESS", "CANCELLED"]));
    expect(body.allowed_next).not.toContain("DONE");
  });

  it("refuses to leave a terminal status", async () => {
    const p = await project();
    const t = await task(p);
    await setStatus(t, "CANCELLED");

    const res = await setStatus(t, "IN_PROGRESS");
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).allowed_next).toEqual([]);
  });

  it("refuses to drop a status a board column still uses", async () => {
    const p = await project();
    const current = await w.app.inject({
      method: "GET",
      url: `/api/v1/projects/${p}/workflow`,
      headers: w.admin,
    });
    const version = (current.json() as { version: number }).version;

    // The project's default board still has an IN_REVIEW column; removing the
    // status would leave that column pointing at nothing.
    const res = await w.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${p}/workflow`,
      headers: { ...w.admin, "if-match": String(version), ...idem() },
      payload: {
        statuses: ["TO_DO", "IN_PROGRESS", "DONE", "CANCELLED"],
        allowed_transitions: {
          TO_DO: ["IN_PROGRESS", "CANCELLED"],
          IN_PROGRESS: ["DONE", "TO_DO"],
          DONE: [],
          CANCELLED: [],
        },
      },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as ErrorBody).code).toBe("WORKFLOW_IN_USE");
  });

  it("honours a per-project workflow override rather than the type default", async () => {
    const p = await project();
    const narrowed = ["TO_DO", "IN_PROGRESS", "DONE", "CANCELLED"];

    // Bring every board on the project down to the statuses being kept, so the
    // narrowing is legal.
    const boards = await w.app.inject({
      method: "GET",
      url: `/api/v1/boards?project_id=${p}`,
      headers: w.admin,
    });
    for (const board of (boards.json() as { data: Array<{ id: string }> }).data) {
      const res = await w.app.inject({
        method: "PUT",
        url: `/api/v1/boards/${board.id}/columns`,
        headers: { ...w.admin, ...(await ifMatch(w, "boards", board.id)), ...idem() },
        payload: {
          columns: narrowed.map((status_code, index) => ({
            status_code,
            name: status_code,
            position: index + 1,
          })),
        },
      });
      expect(res.statusCode, `board ${board.id}`).toBe(200);
    }

    const current = await w.app.inject({
      method: "GET",
      url: `/api/v1/projects/${p}/workflow`,
      headers: w.admin,
    });
    const saved = await w.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${p}/workflow`,
      headers: {
        ...w.admin,
        "if-match": String((current.json() as { version: number }).version),
        ...idem(),
      },
      payload: {
        statuses: narrowed,
        allowed_transitions: {
          TO_DO: ["IN_PROGRESS", "CANCELLED"],
          IN_PROGRESS: ["DONE", "TO_DO"],
          DONE: [],
          CANCELLED: [],
        },
      },
    });
    expect(saved.statusCode).toBe(200);

    const t = await task(p);
    await setStatus(t, "IN_PROGRESS");
    // The type default forbids IN_PROGRESS → DONE; this project's override
    // allows it, and the project's own rule is the one that applies.
    expect((await setStatus(t, "DONE")).statusCode).toBe(200);

    // And a status the override dropped is no longer reachable here.
    const other = await task(p);
    await setStatus(other, "IN_PROGRESS");
    const res = await setStatus(other, "IN_REVIEW");
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).allowed_next).not.toContain("IN_REVIEW");
  });

  it("refuses DONE while a subtask is still open", async () => {
    const p = await project();
    const parent = await task(p);
    await task(p, { parent_task_id: parent });

    await setStatus(parent, "IN_PROGRESS");
    await setStatus(parent, "IN_REVIEW");
    const res = await setStatus(parent, "DONE");
    expect(res.statusCode).toBe(422);
  });
});

describe("UT-WORK-04 apply board drag and API transition through same domain rule", () => {
  /**
   * The Kanban board has no transition endpoint of its own: dragging a card
   * across columns calls the very same status endpoint the list view and the
   * API use (see apps/web/components/KanbanBoard.tsx), while dragging within a
   * column calls board-position, which reorders and nothing else. These tests
   * pin both halves of that contract.
   */
  async function boardFor(projectId: string): Promise<string> {
    return post(w.app, w.admin, "/api/v1/boards", {
      project_id: projectId,
      name: `Board ${uniq()}`,
      view_type: "KANBAN",
      column_config: [
        { status_code: "TO_DO", name: "To do", position: 1 },
        { status_code: "IN_PROGRESS", name: "In progress", position: 2 },
        { status_code: "IN_REVIEW", name: "In review", position: 3 },
        { status_code: "DONE", name: "Done", position: 4 },
      ],
    });
  }

  it("reorders within a column without touching status", async () => {
    const p = await project();
    await boardFor(p);
    const t = await task(p);

    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t}/board-position`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", t)), ...idem() },
      payload: { board_position: 5 },
    });
    expect(res.statusCode).toBe(200);

    const row = await w.pool.query("SELECT status, board_position FROM tasks WHERE id = $1", [t]);
    // Reordering is a view concern; it is not a back door around the workflow.
    expect(row.rows[0].status).toBe("TO_DO");
    expect(row.rows[0].board_position).toBe(5);
  });

  it("puts every cross-column move through the one status endpoint", async () => {
    const p = await project();
    await boardFor(p);

    // Whatever the caller — board drag or API client — the same request is made
    // and the same workflow decision comes back.
    const valid = await task(p);
    expect((await setStatus(valid, "IN_PROGRESS")).statusCode).toBe(200);

    const invalid = await task(p);
    const res = await setStatus(invalid, "DONE");
    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrorBody;
    expect(body.code).toBe("INVALID_TRANSITION");
    expect(body.allowed_next).toEqual(expect.arrayContaining(["IN_PROGRESS", "CANCELLED"]));

    const row = await w.pool.query("SELECT status FROM tasks WHERE id = $1", [invalid]);
    expect(row.rows[0].status).toBe("TO_DO");
  });

  it("applies the same authorization to a reorder as to a transition", async () => {
    const p = await project();
    await boardFor(p);
    const t = await task(p);

    // CLIENT_VIEWER may read a project but must not move work through it, and
    // must not reshuffle someone else's board either.
    const transition = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t}/status`,
      headers: { ...w.role.CLIENT_VIEWER, ...(await ifMatch(w, "tasks", t)), ...idem() },
      payload: { status: "IN_PROGRESS" },
    });
    const reorder = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t}/board-position`,
      headers: { ...w.role.CLIENT_VIEWER, ...(await ifMatch(w, "tasks", t)), ...idem() },
      payload: { board_position: 2 },
    });
    expect(transition.statusCode).toBe(403);
    expect(reorder.statusCode).toBe(403);

    const row = await w.pool.query("SELECT status FROM tasks WHERE id = $1", [t]);
    expect(row.rows[0].status).toBe("TO_DO");
  });

  it("guards both endpoints with the same optimistic-concurrency check", async () => {
    const p = await project();
    const t = await task(p);
    const stale = { "if-match": "999" };

    const transition = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t}/status`,
      headers: { ...w.admin, ...stale, ...idem() },
      payload: { status: "IN_PROGRESS" },
    });
    const reorder = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t}/board-position`,
      headers: { ...w.admin, ...stale, ...idem() },
      payload: { board_position: 3 },
    });
    expect(transition.statusCode).toBe(409);
    expect(reorder.statusCode).toBe(409);
  });
});

describe("UT-WORK-05 close project containing open tasks", () => {
  it("refuses the close and reports how many tasks block it", async () => {
    const p = await project();
    const open1 = await task(p);
    const open2 = await task(p);
    void open1;
    void open2;

    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/projects/${p}/close`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", p)), ...idem() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrorBody;
    expect(body.code).toBe("PROJECT_HAS_OPEN_TASKS");
    // The count (or list) tells the PM how much work is left.
    const blockerCount =
      body.open_count ?? (Array.isArray(body.blockers) ? body.blockers.length : 0);
    expect(blockerCount).toBe(2);

    const row = await w.pool.query("SELECT status FROM projects WHERE id = $1", [p]);
    expect(row.rows[0].status).toBe("ACTIVE");
  });

  it("closes once every task is terminal", async () => {
    const p = await project();
    const t = await task(p);
    await setStatus(t, "IN_PROGRESS");
    await setStatus(t, "IN_REVIEW");
    await setStatus(t, "DONE");

    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/projects/${p}/close`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", p)), ...idem() },
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const row = await w.pool.query("SELECT status FROM projects WHERE id = $1", [p]);
    expect(row.rows[0].status).toBe("CLOSED");

    const audit = await w.pool.query(
      "SELECT action FROM audit_events WHERE entity_id = $1 AND action LIKE 'project.close%'",
      [p],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("counts a cancelled task as closed, not as a blocker", async () => {
    const p = await project();
    const t = await task(p);
    await setStatus(t, "CANCELLED");

    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/projects/${p}/close`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", p)), ...idem() },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("UT-WORK-06 assign task to exited or suspended employee", () => {
  /** A login attached to an employee in the given state. */
  async function userFor(employeeId: string): Promise<string> {
    const username = `cat_assignee_${uniq()}`;
    return createUser(w.pool, w.orgId, {
      username,
      roles: ["EMPLOYEE"],
      employeeId,
    });
  }

  it("refuses a new assignment to an exited employee", async () => {
    const p = await project();
    const userId = await userFor(w.exitedEmployee);
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { ...w.admin, ...idem() },
      payload: { project_id: p, title: "For an exited worker", assignee_id: userId },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const rows = await w.pool.query("SELECT COUNT(*)::int AS n FROM tasks WHERE assignee_id = $1", [
      userId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("refuses a new assignment to a suspended employee", async () => {
    const p = await project();
    const userId = await userFor(w.suspendedEmployee);
    const t = await task(p);
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t}/assign`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", t)), ...idem() },
      payload: { assignee_id: userId, reason: "Reassigning" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const row = await w.pool.query("SELECT assignee_id FROM tasks WHERE id = $1", [t]);
    expect(row.rows[0].assignee_id).not.toBe(userId);
  });

  it("marks work already held by a departing employee as needing reassignment", async () => {
    const p = await project();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const userId = await userFor(employeeId);

    const t = await task(p);
    const assigned = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t}/assign`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", t)), ...idem() },
      payload: { assignee_id: userId, reason: "Initial assignment" },
    });
    expect(assigned.statusCode).toBe(200);

    const exited = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: workDate(), reason: "Left the company" },
    });
    expect(exited.statusCode).toBe(200);

    // The existing task is not silently deleted or reassigned; it stays
    // visible and attributable so a PM can act on it.
    const row = await w.pool.query("SELECT assignee_id, status FROM tasks WHERE id = $1", [t]);
    expect(row.rows[0].assignee_id).toBe(userId);

    // And no further work can be pushed onto them.
    const another = await task(p);
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${another}/assign`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", another)), ...idem() },
      payload: { assignee_id: userId, reason: "Should not be allowed" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("accepts an assignment to an active employee", async () => {
    const p = await project();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const userId = await userFor(employeeId);
    const t = await task(p);
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t}/assign`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", t)), ...idem() },
      payload: { assignee_id: userId, reason: "Active worker" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("UT-WORK-07 close cycle with incomplete work", () => {
  async function cycle(
    projectId: string,
    rollover: "NEXT" | "BACKLOG",
    offsetDays = 0,
  ): Promise<string> {
    const start = new Date(`${workDate()}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + offsetDays);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 13);
    return post(w.app, w.admin, "/api/v1/cycles", {
      project_id: projectId,
      name: `Cycle ${uniq()}`,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      rollover,
    });
  }

  /** Puts a task into a cycle — the planning endpoint owns cycle membership. */
  async function assignToCycle(taskId: string, cycleId: string): Promise<void> {
    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}/planning`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", taskId)), ...idem() },
      payload: { cycle_id: cycleId },
    });
    if (res.statusCode >= 400) {
      throw new Error(`assignToCycle failed: ${res.statusCode} ${res.body}`);
    }
  }

  async function closeCycle(cycleId: string) {
    return w.app.inject({
      method: "POST",
      url: `/api/v1/cycles/${cycleId}/close`,
      headers: { ...w.admin, ...(await ifMatch(w, "cycles", cycleId)), ...idem() },
      payload: {},
    });
  }

  it("moves incomplete work to the configured next cycle", async () => {
    const p = await project();
    const first = await cycle(p, "NEXT");
    const done = await task(p);
    const open = await task(p);
    await assignToCycle(done, first);
    await assignToCycle(open, first);
    await setStatus(done, "IN_PROGRESS");
    await setStatus(done, "IN_REVIEW");
    await setStatus(done, "DONE");

    const res = await closeCycle(first);
    expect(res.statusCode).toBe(200);
    const closed = res.json() as {
      status: string;
      metrics: { planned: number; completed: number; remaining: number; next_cycle_id: string };
    };
    expect(closed.status).toBe("CLOSED");
    expect(closed.metrics.planned).toBe(2);
    expect(closed.metrics.completed).toBe(1);
    expect(closed.metrics.remaining).toBe(1);
    expect(closed.metrics.next_cycle_id).toBeTruthy();

    const rows = await w.pool.query(
      "SELECT id, cycle_id FROM tasks WHERE id = ANY($1::uuid[])",
      [[done, open]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.cycle_id]));
    // Completed work stays where it was done; open work rolls forward.
    expect(byId.get(done)).toBe(first);
    expect(byId.get(open)).toBe(closed.metrics.next_cycle_id);
  });

  it("sends incomplete work to the backlog when configured to", async () => {
    const p = await project();
    const c = await cycle(p, "BACKLOG");
    const open = await task(p);
    await assignToCycle(open, c);

    const res = await closeCycle(c);
    expect(res.statusCode).toBe(200);
    const row = await w.pool.query("SELECT cycle_id FROM tasks WHERE id = $1", [open]);
    // Backlog means "no cycle", not "a new cycle".
    expect(row.rows[0].cycle_id).toBeNull();
  });

  it("preserves the closed cycle's history", async () => {
    const p = await project();
    const c = await cycle(p, "NEXT");
    await assignToCycle(await task(p), c);
    await closeCycle(c);

    const row = await w.pool.query(
      "SELECT status, closed_at, metrics, name FROM cycles WHERE id = $1",
      [c],
    );
    expect(row.rows[0].status).toBe("CLOSED");
    expect(row.rows[0].closed_at).toBeTruthy();
    expect(row.rows[0].metrics).toBeTruthy();
    expect(row.rows[0].name).toBeTruthy();
  });

  it("refuses to close a cycle twice", async () => {
    const p = await project();
    const c = await cycle(p, "BACKLOG");
    expect((await closeCycle(c)).statusCode).toBe(200);
    const again = await closeCycle(c);
    expect(again.statusCode).toBe(409);
    expect((again.json() as ErrorBody).code).toBe("CYCLE_CLOSED");
  });
});

describe("UT-WORK-08 calculate SLA state and delay", () => {
  const TODAY = "2026-09-13";

  it("classifies on schedule, at risk and breached against the IST day", () => {
    expect(
      computeSlaStatus({ status: "IN_PROGRESS", planned_end_date: "2026-09-20" }, TODAY),
    ).toBe("ON_SCHEDULE");
    // Within the two-day warning window.
    expect(
      computeSlaStatus({ status: "IN_PROGRESS", planned_end_date: "2026-09-15" }, TODAY),
    ).toBe("AT_RISK");
    expect(
      computeSlaStatus({ status: "IN_PROGRESS", planned_end_date: "2026-09-13" }, TODAY),
    ).toBe("AT_RISK");
    expect(
      computeSlaStatus({ status: "IN_PROGRESS", planned_end_date: "2026-09-12" }, TODAY),
    ).toBe("OVERDUE");
  });

  it("treats the window boundary deterministically", () => {
    // Exactly two days out is still at risk; three days out is not.
    expect(
      computeSlaStatus({ status: "TO_DO", planned_end_date: "2026-09-15" }, TODAY),
    ).toBe("AT_RISK");
    expect(
      computeSlaStatus({ status: "TO_DO", planned_end_date: "2026-09-16" }, TODAY),
    ).toBe("ON_SCHEDULE");
  });

  it("never flags a finished task", () => {
    for (const status of ["DONE", "CANCELLED"]) {
      expect(
        computeSlaStatus({ status, planned_end_date: "2020-01-01" }, TODAY),
      ).toBe("ON_SCHEDULE");
    }
  });

  it("treats a task with no planned end as on schedule", () => {
    expect(computeSlaStatus({ status: "IN_PROGRESS", planned_end_date: null }, TODAY)).toBe(
      "ON_SCHEDULE",
    );
    expect(
      computeSlaStatus({ status: "IN_PROGRESS", planned_end_date: undefined }, TODAY),
    ).toBe("ON_SCHEDULE");
  });

  it("reports the same status through the task API", async () => {
    const p = await project();
    const overdue = await task(p, { planned_end_date: "2020-01-01" });
    const future = await task(p, { planned_end_date: "2099-01-01" });

    const detail = await w.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${overdue}`,
      headers: w.admin,
    });
    expect((detail.json() as { sla_status: string }).sla_status).toBe("OVERDUE");

    const ok = await w.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${future}`,
      headers: w.admin,
    });
    expect((ok.json() as { sla_status: string }).sla_status).toBe("ON_SCHEDULE");
  });

  it("filters a task list by SLA state", async () => {
    const p = await project();
    const overdue = await task(p, { planned_end_date: "2020-01-01" });
    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/tasks?project_id=${p}&sla=overdue&limit=100`,
      headers: w.admin,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map((t) => t.id);
    expect(ids).toContain(overdue);
  });
});

describe("UT-WORK-09 validate custom fields", () => {
  /**
   * Custom-field values are set through the planning endpoint, and required-ness
   * is enforced when work moves *forward* rather than at creation — quick-add
   * must not demand a form. These tests pin both halves of that rule.
   */
  async function defineField(
    projectId: string,
    definition: Record<string, unknown>,
  ): Promise<string> {
    return post(w.app, w.admin, "/api/v1/custom-fields", {
      project_id: projectId,
      ...definition,
    });
  }

  async function setFields(taskId: string, custom_fields: Record<string, unknown>) {
    return w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}/planning`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", taskId)), ...idem() },
      payload: { custom_fields },
    });
  }

  it("blocks forward progress until a required field is filled", async () => {
    const p = await project();
    await defineField(p, {
      field_key: "site_zone",
      name: "Site zone",
      field_type: "text",
      required: true,
    });

    // Quick-add still works: a draft task does not need the whole form.
    const t = await task(p);

    const blocked = await setStatus(t, "IN_PROGRESS");
    expect(blocked.statusCode).toBe(422);
    expect((blocked.json() as ErrorBody).code).toBe("REQUIRED_CUSTOM_FIELD");

    expect((await setFields(t, { site_zone: "North" })).statusCode).toBe(200);
    expect((await setStatus(t, "IN_PROGRESS")).statusCode).toBe(200);
  });

  it("still allows a task to be parked or cancelled without the field", async () => {
    const p = await project();
    await defineField(p, {
      field_key: "site_zone",
      name: "Site zone",
      field_type: "text",
      required: true,
    });
    const t = await task(p);
    // Cancelling work you are never going to do must not require filling in
    // the form for work you are never going to do.
    expect((await setStatus(t, "CANCELLED")).statusCode).toBe(200);
  });

  it("enforces the declared type", async () => {
    const p = await project();
    await defineField(p, {
      field_key: "crew_size",
      name: "Crew size",
      field_type: "number",
    });
    const t = await task(p);

    const wrong = await setFields(t, { crew_size: "twelve" });
    expect(wrong.statusCode).toBe(422);
    expect((wrong.json() as ErrorBody).code).toBe("INVALID_CUSTOM_FIELD");

    expect((await setFields(t, { crew_size: 12 })).statusCode).toBe(200);
  });

  it("enforces the option list of a select field", async () => {
    const p = await project();
    await defineField(p, {
      field_key: "shift",
      name: "Shift",
      field_type: "select",
      options: ["DAY", "NIGHT"],
    });
    const t = await task(p);

    const invalid = await setFields(t, { shift: "TWILIGHT" });
    expect(invalid.statusCode).toBe(422);
    expect((invalid.json() as ErrorBody).code).toBe("INVALID_CUSTOM_FIELD");

    expect((await setFields(t, { shift: "NIGHT" })).statusCode).toBe(200);
  });

  it("rejects a value for a field this project does not define", async () => {
    const p = await project();
    const t = await task(p);
    const res = await setFields(t, { not_a_field: "anything" });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("UNKNOWN_CUSTOM_FIELD");
  });

  it("requires a user field to name an active colleague", async () => {
    const p = await project();
    await defineField(p, {
      field_key: "inspector",
      name: "Inspector",
      field_type: "user",
    });
    const t = await task(p);

    const notAUser = await setFields(t, {
      inspector: "00000000-0000-0000-0000-000000000000",
    });
    expect(notAUser.statusCode).toBe(422);
    expect((notAUser.json() as ErrorBody).code).toBe("INVALID_CUSTOM_FIELD");

    expect((await setFields(t, { inspector: w.adminId })).statusCode).toBe(200);
  });

  it("keeps definitions scoped to their own project", async () => {
    const withField = await project();
    await defineField(withField, {
      field_key: "only_here",
      name: "Only here",
      field_type: "text",
      required: true,
    });

    const otherProject = await project();
    const t = await task(otherProject);
    // The other project has no such requirement, so work moves freely there.
    expect((await setStatus(t, "IN_PROGRESS")).statusCode).toBe(200);
  });
});

describe("UT-WORK-10 execute automation action outside workflow or actor authority", () => {
  /**
   * A rule whose acting user holds automation.manage but whose action the
   * workflow forbids. The worker runs the action through the ordinary domain
   * endpoint, so the rule cannot do anything its actor could not do by hand.
   */
  it("fails the action, changes no business data, and logs the reason", async () => {
    const p = await project();
    const t = await task(p);

    const rule = await post(w.app, w.admin, "/api/v1/automation-rules", {
      project_id: p,
      name: `Illegal transition ${uniq()}`,
      trigger: "task.create",
      conditions: [],
      // TO_DO → DONE is not an edge in the workflow.
      actions: [{ type: "status", value: "DONE" }],
      active: true,
    });

    const event = await w.pool.query(
      `INSERT INTO domain_events (org_id, actor_id, type, entity_type, entity_id, payload)
       VALUES ($1, $2, 'task.create', 'task', $3, $4::jsonb) RETURNING id`,
      [w.orgId, w.adminId, t, JSON.stringify({ project_id: p })],
    );

    await drainJobs();

    const row = await w.pool.query("SELECT status FROM tasks WHERE id = $1", [t]);
    // The business data is untouched.
    expect(row.rows[0].status).toBe("TO_DO");

    const execution = await w.pool.query(
      "SELECT status, results FROM automation_executions WHERE rule_id = $1 AND event_id = $2",
      [rule, event.rows[0].id],
    );
    expect(execution.rowCount).toBe(1);
    expect(execution.rows[0].status).toBe("FAILED");
    // The execution log names *why*, not just that it failed.
    const results = execution.rows[0].results as Array<{ code?: string; status: number }>;
    expect(results[0]!.status).toBe(422);
    expect(results[0]!.code).toBe("INVALID_TRANSITION");
  });

  it("refuses to create a rule whose action exceeds the author's authority", async () => {
    const p = await project();
    // TEAM_LEAD does not hold task.assign, so it cannot author an assigning rule.
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/automation-rules",
      headers: { ...w.role.TEAM_LEAD, ...idem() },
      payload: {
        project_id: p,
        name: "Assign on create",
        trigger: "task.create",
        conditions: [],
        actions: [{ type: "assign", value: w.adminId }],
        active: true,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("stops running a rule whose acting user has been disabled", async () => {
    const p = await project();
    const username = `cat_rule_owner_${uniq()}`;
    const ownerId = await createUser(w.pool, w.orgId, {
      username,
      roles: ["ADMIN"],
    });
    const ownerHeaders = await loginAs(w.app, username);

    const rule = await post(w.app, ownerHeaders, "/api/v1/automation-rules", {
      project_id: p,
      name: `Owned rule ${uniq()}`,
      trigger: "task.create",
      conditions: [],
      actions: [{ type: "status", value: "IN_PROGRESS" }],
      active: true,
    });

    // The rule's authority is the person's, so revoking the person revokes it.
    await w.pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1", [ownerId]);

    const t = await task(p);
    await w.pool.query(
      `INSERT INTO domain_events (org_id, actor_id, type, entity_type, entity_id, payload)
       VALUES ($1, $2, 'task.create', 'task', $3, $4::jsonb)`,
      [w.orgId, w.adminId, t, JSON.stringify({ project_id: p })],
    );
    await drainJobs();

    const row = await w.pool.query("SELECT status FROM tasks WHERE id = $1", [t]);
    expect(row.rows[0].status).toBe("TO_DO");
    const executions = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM automation_executions WHERE rule_id = $1",
      [rule],
    );
    expect(executions.rows[0].n).toBe(0);
  });
});

describe("UT-WORK-11 repeat the same automation event", () => {
  it("executes a rule at most once per event", async () => {
    const p = await project();
    const t = await task(p);
    const rule = await post(w.app, w.admin, "/api/v1/automation-rules", {
      project_id: p,
      name: `Dedup probe ${uniq()}`,
      trigger: "task.create",
      conditions: [],
      actions: [{ type: "status", value: "IN_PROGRESS" }],
      active: true,
    });

    const event = await w.pool.query(
      `INSERT INTO domain_events (org_id, actor_id, type, entity_type, entity_id, payload)
       VALUES ($1, $2, 'task.create', 'task', $3, $4::jsonb) RETURNING id`,
      [w.orgId, w.adminId, t, JSON.stringify({ project_id: p })],
    );
    const eventId = event.rows[0].id as string;

    await drainJobs();
    // Replay the same event twice, as a crashed worker would.
    await replayEvent(eventId);
    await drainJobs();
    await replayEvent(eventId);
    await drainJobs();

    const executions = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM automation_executions WHERE rule_id = $1 AND event_id = $2",
      [rule, eventId],
    );
    expect(executions.rows[0].n).toBe(1);

    // And the action itself ran once: the task advanced one step, not three.
    const row = await w.pool.query("SELECT status, version FROM tasks WHERE id = $1", [t]);
    expect(row.rows[0].status).toBe("IN_PROGRESS");
  });

  it("deduplicates the notification a repeated event would raise", async () => {
    const p = await project();
    const t = await task(p);
    const recipient = w.roleUserId.PROJECT_MANAGER;
    const rule = await post(w.app, w.admin, "/api/v1/automation-rules", {
      project_id: p,
      name: `Notify dedup ${uniq()}`,
      trigger: "task.create",
      conditions: [],
      actions: [{ type: "notify", value: recipient }],
      active: true,
    });

    const event = await w.pool.query(
      `INSERT INTO domain_events (org_id, actor_id, type, entity_type, entity_id, payload)
       VALUES ($1, $2, 'task.create', 'task', $3, $4::jsonb) RETURNING id`,
      [w.orgId, w.adminId, t, JSON.stringify({ project_id: p })],
    );
    const eventId = event.rows[0].id as string;

    for (let i = 0; i < 3; i += 1) {
      await drainJobs();
      await replayEvent(eventId);
    }

    // Dedup is per (event, rule, action): the task's own creation event is a
    // different event and legitimately raises its own item, so the assertion is
    // scoped to the key this replayed event produces.
    const notifications = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM notifications WHERE recipient_id = $1 AND event_key = $2",
      [recipient, `automation:${eventId}:${rule}:0`],
    );
    expect(notifications.rows[0].n).toBe(1);
  });
});

describe("UT-WORK-12 change board/filter configuration", () => {
  it("audits a board column change and leaves task records untouched", async () => {
    const p = await project();
    const boardId = await post(w.app, w.admin, "/api/v1/boards", {
      project_id: p,
      name: `Config board ${uniq()}`,
      view_type: "KANBAN",
      column_config: [
        { status_code: "TO_DO", name: "To do", position: 1 },
        { status_code: "IN_PROGRESS", name: "Doing", position: 2 },
        { status_code: "DONE", name: "Done", position: 3 },
      ],
    });
    const t = await task(p);
    const before = await w.pool.query(
      "SELECT status, version, updated_at FROM tasks WHERE id = $1",
      [t],
    );

    const res = await w.app.inject({
      method: "PUT",
      url: `/api/v1/boards/${boardId}/columns`,
      headers: { ...w.admin, ...(await ifMatch(w, "boards", boardId)), ...idem() },
      payload: {
        columns: [
          { status_code: "TO_DO", name: "Backlog", position: 1 },
          { status_code: "IN_PROGRESS", name: "In flight", position: 2 },
          { status_code: "IN_REVIEW", name: "Review", position: 3 },
          { status_code: "DONE", name: "Shipped", position: 4 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    // A board is a view. Renaming its columns must not touch a single task.
    const after = await w.pool.query(
      "SELECT status, version, updated_at FROM tasks WHERE id = $1",
      [t],
    );
    expect(after.rows[0].status).toBe(before.rows[0].status);
    expect(after.rows[0].version).toBe(before.rows[0].version);
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);

    const audit = await w.pool.query(
      "SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY created_at DESC",
      [boardId],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(audit.rows.map((r) => r.action).join(" ")).toMatch(/board/i);
  });

  it("audits a saved-filter change without touching the matched tasks", async () => {
    const p = await project();
    const t = await task(p);
    const filterId = await post(w.app, w.admin, "/api/v1/saved-filters", {
      project_id: p,
      name: `Filter ${uniq()}`,
      query_definition: { project_id: p, status: ["TO_DO"] },
    });
    const before = await w.pool.query("SELECT version FROM tasks WHERE id = $1", [t]);

    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/saved-filters/${filterId}`,
      headers: { ...w.admin, ...idem() },
      payload: { name: `Filter renamed ${uniq()}` },
    });
    expect(res.statusCode).toBe(200);

    const after = await w.pool.query("SELECT version FROM tasks WHERE id = $1", [t]);
    expect(after.rows[0].version).toBe(before.rows[0].version);

    const audit = await w.pool.query(
      "SELECT action FROM audit_events WHERE entity_id = $1",
      [filterId],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("refuses a board configuration that contradicts the project workflow", async () => {
    const p = await project();
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/boards",
      headers: { ...w.admin, ...idem() },
      payload: {
        project_id: p,
        name: `Bad board ${uniq()}`,
        view_type: "KANBAN",
        column_config: [{ status_code: "NOT_A_STATUS", name: "Nope", position: 1 }],
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

/**
 * The commercial facts on a project (§8, §8.8, §15.1, §37).
 *
 * These columns have existed since the conversion lineage migration, but only
 * a tender conversion ever wrote them and the read API never returned them —
 * so a government job and a private one looked identical in every screen, and
 * a directly created project had no contract value for any margin report to
 * measure cost against.
 */
describe("UT-WORK-13 project commercial fields", () => {
  async function makeClient(): Promise<string> {
    const r = await w.pool.query(
      `INSERT INTO clients(org_id, created_by, code, name, client_type, status)
       VALUES($1,$2,$3,$4,'GOVERNMENT','ACTIVE') RETURNING id`,
      [w.orgId, w.adminId, uniq("CL"), `Client ${uniq()}`]);
    return String(r.rows[0].id);
  }

  it("accepts the track, client, contract value and work order on create", async () => {
    const clientId = await makeClient();
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...w.admin, ...idem() },
      payload: {
        workspace_id: w.workspaceId,
        code: `GOV${uniq().toUpperCase().slice(-6)}`,
        name: "District road widening",
        project_kind: "GOVERNMENT",
        client_id: clientId,
        contract_value: 12_500_000,
        work_order_number: "WO/2026/PR/118",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.project_kind).toBe("GOVERNMENT");
    expect(body.client_id).toBe(clientId);
    expect(body.contract_value).toBe(12_500_000);
    expect(body.work_order_number).toBe("WO/2026/PR/118");
  });

  it("returns them on read, not only on the create response", async () => {
    // The original defect: the insert could have carried them and the GET
    // still would not show them, because PROJECT_COLS left them out.
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...w.admin, ...idem() },
      payload: {
        workspace_id: w.workspaceId,
        code: `PVT${uniq().toUpperCase().slice(-6)}`,
        name: "Private campus works",
        project_kind: "PRIVATE",
        contract_value: 4_200_000,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id;

    const read = await w.app.inject({
      method: "GET", url: `/api/v1/projects/${id}`, headers: w.admin,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().project_kind).toBe("PRIVATE");
    expect(read.json().contract_value).toBe(4_200_000);
  });

  it("leaves a project with no commercial detail reading as unset, not zero", async () => {
    // Null is "not recorded"; zero would claim the job is worth nothing.
    const id = await project("Plain project");
    const read = await w.app.inject({
      method: "GET", url: `/api/v1/projects/${id}`, headers: w.admin,
    });
    expect(read.json().project_kind).toBeNull();
    expect(read.json().contract_value).toBeNull();
  });

  it("refuses a track it does not recognise", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...w.admin, ...idem() },
      payload: {
        workspace_id: w.workspaceId,
        code: `BAD${uniq().toUpperCase().slice(-6)}`,
        name: "Wrong track",
        project_kind: "MUNICIPAL",
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses a client from another organisation", async () => {
    const other = await w.pool.query(
      `INSERT INTO clients(org_id, created_by, code, name, client_type, status)
       VALUES($1,$2,$3,$4,'PRIVATE','ACTIVE') RETURNING id`,
      [w.other.orgId, w.other.adminId, uniq("CL"), `Foreign ${uniq()}`]);
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...w.admin, ...idem() },
      payload: {
        workspace_id: w.workspaceId,
        code: `XORG${uniq().toUpperCase().slice(-5)}`,
        name: "Cross tenant",
        client_id: String(other.rows[0].id),
      },
    });
    // The foreign key is scoped to the row, not the tenant, so this must be
    // caught rather than quietly linking a client nobody in this org can see.
    expect([403, 404, 422]).toContain(res.statusCode);
  });

  it("lets a project acquire its commercial detail later", async () => {
    // Work often starts before the award paperwork lands.
    const id = await project("Later award");
    const current = await w.app.inject({
      method: "GET", url: `/api/v1/projects/${id}`, headers: w.admin,
    });
    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${id}`,
      headers: { ...w.admin, "if-match": String(current.json().version), ...idem() },
      payload: { project_kind: "GOVERNMENT", contract_value: 900_000 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().project_kind).toBe("GOVERNMENT");
    expect(res.json().contract_value).toBe(900_000);
  });

  it("still refuses a patch that changes nothing", async () => {
    const id = await project("No-op patch");
    const current = await w.app.inject({
      method: "GET", url: `/api/v1/projects/${id}`, headers: w.admin,
    });
    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${id}`,
      headers: { ...w.admin, "if-match": String(current.json().version), ...idem() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });
});

/**
 * Project categories — what the work is about (§6.2).
 *
 * Kept separate from the project type, which is how the work is contracted.
 * Folding them together would multiply the type list into every combination
 * of arrangement and subject.
 */
describe("UT-WORK-14 project categories", () => {
  it("seeds the categories the business asked for", async () => {
    const res = await w.app.inject({
      method: "GET", url: "/api/v1/project-categories", headers: w.admin,
    });
    expect(res.statusCode).toBe(200);
    const names = res.json().data.map((c: { name: string }) => c.name);
    for (const expected of ["Electronics", "Drones", "CCTV Equipment", "Survey Equipment", "Land Survey"]) {
      expect(names).toContain(expected);
    }
  });

  it("creates one from the Projects screen without leaving it", async () => {
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/project-categories",
      headers: { ...w.admin, ...idem() },
      payload: { name: `Thermal Imaging ${uniq()}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.code).toMatch(/^thermal_imaging_/);
  });

  it("normalises the code so one category cannot become two", async () => {
    // "CCTV Equipment" typed a second time as "cctv equipment" must land on
    // the row that already exists, not create a rival master.
    const label = `Drone Fleet ${uniq()}`;
    const first = await w.app.inject({
      method: "POST", url: "/api/v1/project-categories",
      headers: { ...w.admin, ...idem() }, payload: { name: label },
    });
    expect(first.statusCode, first.body).toBe(201);
    const again = await w.app.inject({
      method: "POST", url: "/api/v1/project-categories",
      headers: { ...w.admin, ...idem() },
      payload: { code: `  ${label.toUpperCase()}  `, name: label },
    });
    // Returns the existing row rather than an error: the caller is a person
    // filling in a form, and a dead end is a worse answer than the row.
    expect(again.statusCode).toBe(200);
    expect(again.json().data.id).toBe(first.json().data.id);
  });

  it("links a category to a project and returns it on read", async () => {
    const cats = await w.app.inject({
      method: "GET", url: "/api/v1/project-categories", headers: w.admin,
    });
    const drones = cats.json().data.find((c: { code: string }) => c.code === "drones");
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/projects",
      headers: { ...w.admin, ...idem() },
      payload: {
        workspace_id: w.workspaceId,
        code: `CAT${uniq().toUpperCase().slice(-6)}`,
        name: "Drone survey",
        project_category_id: drones.id,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().project_category_id).toBe(drones.id);
  });

  it("refuses a category from another organisation", async () => {
    const foreign = await w.pool.query(
      `INSERT INTO project_categories(org_id, code, name) VALUES($1,$2,$3) RETURNING id`,
      [w.other.orgId, uniq("c"), "Foreign category"]);
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/projects",
      headers: { ...w.admin, ...idem() },
      payload: {
        workspace_id: w.workspaceId,
        code: `XCAT${uniq().toUpperCase().slice(-5)}`,
        name: "Cross tenant category",
        project_category_id: String(foreign.rows[0].id),
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("records which side of GST the contract value sits on", async () => {
    // Booking an inclusive figure as exclusive overstates every margin on the
    // job by the tax rate, so the answer is stored rather than assumed.
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/projects",
      headers: { ...w.admin, ...idem() },
      payload: {
        workspace_id: w.workspaceId,
        code: `GST${uniq().toUpperCase().slice(-6)}`,
        name: "Inclusive contract",
        contract_value: 1_180_000,
        contract_gst_included: true,
        contract_gst_rate: 18,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().contract_gst_included).toBe(true);
    expect(res.json().contract_gst_rate).toBe(18);
  });

  it("refuses a rate with nobody saying which side it applies to", async () => {
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/projects",
      headers: { ...w.admin, ...idem() },
      payload: {
        workspace_id: w.workspaceId,
        code: `GSTX${uniq().toUpperCase().slice(-5)}`,
        name: "Rate with no side",
        contract_value: 100000,
        contract_gst_rate: 18,
      },
    });
    // The database constraint refuses the pair; the API surfaces it rather
    // than storing a rate that cannot be applied.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

/**
 * The people directory (§4, §12.2).
 *
 * Tasks carry a user id, but nobody refers to a colleague as a UUID. Before
 * this endpoint the only user list was /admin/users, gated on users.read —
 * which a project manager does not hold — so every assign field asked for an
 * identifier the user had to find elsewhere and paste.
 */
describe("UT-WORK-15 people directory", () => {
  it("returns the employee name, not the sign-in name, where there is one", async () => {
    const res = await w.app.inject({ method: "GET", url: "/api/v1/people", headers: w.admin });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; name: string; employee_id: string | null }>;
    const linked = rows.find((r) => r.employee_id);
    expect(linked).toBeTruthy();
    const employee = await w.pool.query(
      "SELECT first_name, last_name FROM employees WHERE id = $1", [linked!.employee_id]);
    expect(linked!.name).toBe(
      `${employee.rows[0].first_name} ${employee.rows[0].last_name}`.trim());
  });

  it("falls back to the sign-in name for an account with no employee record", async () => {
    // A service or administrator login still has to be selectable; showing a
    // blank row would make it unpickable and look like data loss.
    const res = await w.app.inject({ method: "GET", url: "/api/v1/people", headers: w.admin });
    const rows = res.json().data as Array<{ name: string; employee_id: string | null; username: string }>;
    for (const r of rows.filter((x) => !x.employee_id)) {
      expect(r.name).toBe(r.username);
    }
    for (const r of rows) expect(r.name.trim().length).toBeGreaterThan(0);
  });

  it("is readable by a project manager, who cannot read the admin user list", async () => {
    // The whole point: the assign field is used by people who do not hold
    // users.read, and gating the directory on it is what forced the UUID.
    const admin = await w.app.inject({
      method: "GET", url: "/api/v1/admin/users", headers: w.role.PROJECT_MANAGER,
    });
    expect(admin.statusCode).toBe(403);
    const people = await w.app.inject({
      method: "GET", url: "/api/v1/people", headers: w.role.PROJECT_MANAGER,
    });
    expect(people.statusCode).toBe(200);
  });

  it("carries no contact details beyond what a task card already shows", async () => {
    const res = await w.app.inject({ method: "GET", url: "/api/v1/people", headers: w.admin });
    const keys = new Set(Object.keys(res.json().data[0] ?? {}));
    for (const leaked of ["email", "phone", "aadhaar", "pan", "password_hash", "bank_account"]) {
      expect(keys.has(leaked), `${leaked} must not be in the directory`).toBe(false);
    }
  });

  it("stays inside the organisation", async () => {
    const mine = await w.app.inject({ method: "GET", url: "/api/v1/people", headers: w.admin });
    const theirs = await w.app.inject({ method: "GET", url: "/api/v1/people", headers: w.other.admin });
    const mineIds = new Set((mine.json().data as Array<{ id: string }>).map((r) => r.id));
    for (const r of theirs.json().data as Array<{ id: string }>) {
      expect(mineIds.has(r.id)).toBe(false);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await w.app.inject({ method: "GET", url: "/api/v1/people" });
    expect(res.statusCode).toBe(401);
  });
});
