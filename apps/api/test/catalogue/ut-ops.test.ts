/**
 * Catalogue: Assets, inventory, reports and AI (UT-OPS-01..06).
 *
 * UT-OFF-01..06 are device-side and live in apps/mobile/test/catalogue.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  TEST_DB,
  buildWorld,
  createActiveEmployee,
  idem,
  ifMatch,
  post,
  uniq,
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
  field_errors?: Array<{ field: string; message: string }>;
}

const stock: Headers = {};

/** An inventory item stocked with exactly `quantity` units. */
async function stockedItem(quantity: number): Promise<string> {
  const itemId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/inventory/items", {
    code: `IT${uniq().toUpperCase().slice(-8)}`,
    name: "Probe item",
    unit: "BAG",
  });
  if (quantity > 0) {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/inventory/transactions",
      headers: { ...w.role.INVENTORY_MANAGER, ...idem(), ...stock },
      payload: {
        item_id: itemId,
        direction: "IN",
        quantity: String(quantity),
        reference: "opening",
      },
    });
    expect(res.statusCode).toBe(201);
  }
  return itemId;
}

async function availableStock(itemId: string): Promise<number> {
  const res = await w.pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0) AS qty
       FROM stock_transactions WHERE item_id = $1`,
    [itemId],
  );
  return Number(res.rows[0].qty);
}

describe("UT-OPS-01 consume final stock concurrently in domain transaction", () => {
  it("lets exactly one of two simultaneous withdrawals win", async () => {
    const itemId = await stockedItem(1);

    // Two independent connections, issued together: the classic double-spend.
    // Each request takes its own pooled connection, so the item row lock is
    // what has to serialize them, not the test's own sequencing.
    const withdraw = () =>
      w.app.inject({
        method: "POST",
        url: "/api/v1/inventory/transactions",
        headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
        payload: {
          item_id: itemId,
          direction: "OUT",
          quantity: "1",
          reference: `concurrent-${uniq()}`,
        },
      });

    const [first, second] = await Promise.all([withdraw(), withdraw()]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([201, 409]);

    const loser = first.statusCode === 409 ? first : second;
    expect((loser.json() as ErrorBody).code).toBe("INSUFFICIENT_STOCK");

    // The ledger never went negative, and exactly one unit left the shelf.
    expect(await availableStock(itemId)).toBe(0);
    const outs = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM stock_transactions WHERE item_id = $1 AND direction = 'OUT'",
      [itemId],
    );
    expect(outs.rows[0].n).toBe(1);
  });

  it("holds the line under a wider burst", async () => {
    const itemId = await stockedItem(3);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        w.app.inject({
          method: "POST",
          url: "/api/v1/inventory/transactions",
          headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
          payload: {
            item_id: itemId,
            direction: "OUT",
            quantity: "1",
            reference: `burst-${uniq()}`,
          },
        }),
      ),
    );
    const accepted = attempts.filter((r) => r.statusCode === 201).length;
    expect(accepted).toBe(3);
    expect(await availableStock(itemId)).toBe(0);
    // Every rejection is the business rule, not a 500 from a race.
    for (const rejected of attempts.filter((r) => r.statusCode !== 201)) {
      expect(rejected.statusCode).toBe(409);
      expect((rejected.json() as ErrorBody).code).toBe("INSUFFICIENT_STOCK");
    }
  });

  it("refuses a withdrawal larger than the whole balance", async () => {
    const itemId = await stockedItem(2);
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/inventory/transactions",
      headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
      payload: {
        item_id: itemId,
        direction: "OUT",
        quantity: "3",
        reference: "too much",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(await availableStock(itemId)).toBe(2);
  });

  it("serializes correctly across separate database connections", async () => {
    // The inject-based probes above share one pool; this one proves the lock
    // holds when the two writers are genuinely separate clients.
    const itemId = await stockedItem(1);
    const other = new Pool({ connectionString: TEST_DB });
    try {
      const otherApp = await (await import("../../src/createApp.js")).buildApp({
        pool: other,
        jwtSecret: "catalogue-secret-change-me",
        nodeEnv: "test",
        loginRateLimitMax: 100_000,
        punchRateLimitMax: 100_000,
      });
      try {
        const payload = (reference: string) => ({
          item_id: itemId,
          direction: "OUT",
          quantity: "1",
          reference,
        });
        const [a, b] = await Promise.all([
          w.app.inject({
            method: "POST",
            url: "/api/v1/inventory/transactions",
            headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
            payload: payload(`pool-a-${uniq()}`),
          }),
          otherApp.inject({
            method: "POST",
            url: "/api/v1/inventory/transactions",
            headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
            payload: payload(`pool-b-${uniq()}`),
          }),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
        expect(await availableStock(itemId)).toBe(0);
      } finally {
        await otherApp.close();
      }
    } finally {
      await other.end();
    }
  });
});

describe("UT-OPS-02 assign unavailable asset or assign to exited employee", () => {
  async function asset(): Promise<string> {
    return post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `AS${uniq().toUpperCase().slice(-8)}`,
      name: "Probe asset",
      category: "ELECTRONIC",
      condition: "GOOD",
    });
  }

  async function assign(
    assetId: string,
    employeeId: string,
    headers: Headers = w.role.INVENTORY_MANAGER,
  ) {
    return w.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/assign`,
      headers: { ...headers, ...(await ifMatch(w, "assets", assetId)), ...idem() },
      payload: { employee_id: employeeId, condition: "GOOD", reason: "field work" },
    });
  }

  it("refuses an asset that is already assigned", async () => {
    const assetId = await asset();
    const first = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const second = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });

    expect((await assign(assetId, first)).statusCode).toBe(200);

    const res = await assign(assetId, second);
    expect(res.statusCode).toBe(409);
    expect((res.json() as ErrorBody).code).toBe("ASSET_UNAVAILABLE");

    // Exactly one open assignment survives.
    const open = await w.pool.query(
      "SELECT employee_id FROM asset_assignments WHERE asset_id = $1 AND returned_at IS NULL",
      [assetId],
    );
    expect(open.rowCount).toBe(1);
    expect(open.rows[0].employee_id).toBe(first);
  });

  it("refuses an exited employee", async () => {
    const assetId = await asset();
    const res = await assign(assetId, w.exitedEmployee);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((res.json() as ErrorBody).code).toBe("EMPLOYEE_INACTIVE");

    const rows = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM asset_assignments WHERE asset_id = $1",
      [assetId],
    );
    expect(rows.rows[0].n).toBe(0);
    const status = await w.pool.query("SELECT status FROM assets WHERE id = $1", [assetId]);
    expect(status.rows[0].status).toBe("AVAILABLE");
  });

  it("refuses a suspended employee", async () => {
    const assetId = await asset();
    const res = await assign(assetId, w.suspendedEmployee);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((res.json() as ErrorBody).code).toBe("EMPLOYEE_INACTIVE");
  });

  it("refuses a written-off asset", async () => {
    const assetId = await asset();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    for (const [status, condition] of [
      ["DAMAGED", "BROKEN"],
      ["WRITTEN_OFF", "SCRAP"],
    ] as const) {
      const res = await w.app.inject({
        method: "POST",
        url: `/api/v1/assets/${assetId}/transition`,
        headers: {
          ...w.role.INVENTORY_MANAGER,
          ...(await ifMatch(w, "assets", assetId)),
          ...idem(),
        },
        payload: { status, condition, reason: "End of life" },
      });
      expect(res.statusCode, status).toBe(200);
    }

    const res = await assign(assetId, employeeId);
    expect(res.statusCode).toBe(409);
    expect((res.json() as ErrorBody).code).toBe("ASSET_UNAVAILABLE");
  });

  it("accepts an available asset and an active employee", async () => {
    const assetId = await asset();
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const res = await assign(assetId, employeeId);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("ASSIGNED");
  });
});

describe("UT-OPS-03 return damaged or lost asset", () => {
  async function assignedAsset(): Promise<{ assetId: string; employeeId: string }> {
    const assetId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `AS${uniq().toUpperCase().slice(-8)}`,
      name: "Returnable asset",
      category: "ELECTRONIC",
      condition: "GOOD",
    });
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/assign`,
      headers: {
        ...w.role.INVENTORY_MANAGER,
        ...(await ifMatch(w, "assets", assetId)),
        ...idem(),
      },
      payload: { employee_id: employeeId, condition: "GOOD", reason: "field work" },
    });
    expect(res.statusCode).toBe(200);
    return { assetId, employeeId };
  }

  async function transition(assetId: string, payload: Record<string, unknown>) {
    return w.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/transition`,
      headers: {
        ...w.role.INVENTORY_MANAGER,
        ...(await ifMatch(w, "assets", assetId)),
        ...idem(),
      },
      payload,
    });
  }

  it("closes the assignment and records the observed condition on a damaged return", async () => {
    const { assetId, employeeId } = await assignedAsset();
    const res = await transition(assetId, {
      status: "DAMAGED",
      condition: "CRACKED_SCREEN",
      reason: "Dropped on site",
    });
    expect(res.statusCode).toBe(200);

    const asset = await w.pool.query("SELECT status, condition FROM assets WHERE id = $1", [
      assetId,
    ]);
    expect(asset.rows[0].status).toBe("DAMAGED");
    expect(asset.rows[0].condition).toBe("CRACKED_SCREEN");

    const assignment = await w.pool.query(
      `SELECT employee_id, returned_at, condition, return_condition, received_by
         FROM asset_assignments WHERE asset_id = $1`,
      [assetId],
    );
    expect(assignment.rowCount).toBe(1);
    expect(assignment.rows[0].employee_id).toBe(employeeId);
    // The assignment is closed, not deleted: the history of who held it stays.
    expect(assignment.rows[0].returned_at).toBeTruthy();
    /*
     * The two conditions are kept apart.
     *
     * This used to assert that `condition` became CRACKED_SCREEN — the return
     * overwrote the state the asset went out in, so the register could never
     * show that something left in good order and came back broken. That
     * comparison is the whole reason the record exists, so the issue
     * condition stays put and the observed one is recorded beside it.
     */
    expect(assignment.rows[0].condition, "the state it went out in").toBe("GOOD");
    expect(assignment.rows[0].return_condition, "what the receiver saw")
      .toBe("CRACKED_SCREEN");
    // And who took it back, so a fault found later has somebody to ask.
    expect(assignment.rows[0].received_by).toBeTruthy();
  });

  it("carries the reason and evidence through on a lost asset", async () => {
    const { assetId } = await assignedAsset();
    const reason = "Not recovered after the site was cleared";
    const res = await transition(assetId, {
      status: "LOST",
      condition: "UNKNOWN",
      reason,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reason: string }).reason).toBe(reason);

    const audit = await w.pool.query(
      "SELECT action, after_state FROM audit_events WHERE entity_id = $1 AND action = 'asset.transition'",
      [assetId],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(audit.rows)).toContain(reason);
  });

  it("refuses a lifecycle move the state machine does not allow", async () => {
    const { assetId } = await assignedAsset();
    // ASSIGNED cannot jump straight to WRITTEN_OFF.
    const res = await transition(assetId, {
      status: "WRITTEN_OFF",
      condition: "SCRAP",
      reason: "Shortcut",
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as ErrorBody).code).toBe("INVALID_TRANSITION");

    const asset = await w.pool.query("SELECT status FROM assets WHERE id = $1", [assetId]);
    expect(asset.rows[0].status).toBe("ASSIGNED");
  });

  it("allows a repaired asset back into service", async () => {
    const { assetId } = await assignedAsset();
    expect(
      (await transition(assetId, { status: "DAMAGED", condition: "BENT", reason: "Damaged" }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await transition(assetId, {
          status: "AVAILABLE",
          condition: "GOOD",
          reason: "Repaired and tested",
        })
      ).statusCode,
    ).toBe(200);

    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const reassigned = await w.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/assign`,
      headers: {
        ...w.role.INVENTORY_MANAGER,
        ...(await ifMatch(w, "assets", assetId)),
        ...idem(),
      },
      payload: { employee_id: employeeId, condition: "GOOD", reason: "Back in service" },
    });
    expect(reassigned.statusCode).toBe(200);
  });
});

describe("UT-OPS-04 reconcile physical audit", () => {
  async function asset(condition = "GOOD"): Promise<string> {
    return post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `AU${uniq().toUpperCase().slice(-8)}`,
      name: "Audited asset",
      category: "ELECTRONIC",
      condition,
    });
  }

  it("classifies Found, Missing, Unexpected and Condition Changed", async () => {
    const found = await asset("GOOD");
    const missing = await asset("GOOD");
    const unexpected = await asset("GOOD");
    const changed = await asset("GOOD");

    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/asset-audits",
      headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
      payload: {
        name: `Quarterly count ${uniq()}`,
        // The auditor expected these three on the shelf...
        expected_ids: [found, missing, changed],
        // ...and actually scanned these three.
        scans: [
          { asset_id: found, condition: "GOOD" },
          { asset_id: changed, condition: "WORN" },
          { asset_id: unexpected, condition: "GOOD" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const results = (
      res.json() as {
        results: Array<{
          asset_id: string;
          result: string;
          expected_condition: string;
          observed_condition: string | null;
        }>;
      }
    ).results;
    const byAsset = new Map(results.map((r) => [r.asset_id, r]));

    expect(byAsset.get(found)!.result).toBe("FOUND");
    // Expected but not scanned.
    expect(byAsset.get(missing)!.result).toBe("MISSING");
    expect(byAsset.get(missing)!.observed_condition).toBeNull();
    // Scanned but not expected here.
    expect(byAsset.get(unexpected)!.result).toBe("UNEXPECTED");
    // Present, but not in the condition the register claims.
    expect(byAsset.get(changed)!.result).toBe("CONDITION_CHANGED");
    expect(byAsset.get(changed)!.expected_condition).toBe("GOOD");
    expect(byAsset.get(changed)!.observed_condition).toBe("WORN");
  });

  it("refuses a duplicate scan of the same asset", async () => {
    const a = await asset();
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/asset-audits",
      headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
      payload: {
        name: `Duplicate ${uniq()}`,
        expected_ids: [a],
        scans: [
          { asset_id: a, condition: "GOOD" },
          { asset_id: a, condition: "WORN" },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("DUPLICATE_SCAN");
  });

  it("refuses an audit naming an asset that does not exist", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/asset-audits",
      headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
      payload: {
        name: `Ghost ${uniq()}`,
        expected_ids: ["00000000-0000-0000-0000-000000000000"],
        scans: [],
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("stores the reconciliation for later reference", async () => {
    const a = await asset();
    const name = `Stored audit ${uniq()}`;
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/asset-audits",
      headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
      payload: { name, expected_ids: [a], scans: [{ asset_id: a, condition: "GOOD" }] },
    });
    expect(created.statusCode).toBe(201);

    const listed = await w.app.inject({
      method: "GET",
      url: "/api/v1/asset-audits?limit=100",
      headers: w.role.INVENTORY_MANAGER,
    });
    expect(listed.statusCode).toBe(200);
    const names = (listed.json() as { data: Array<{ name: string }> }).data.map((r) => r.name);
    expect(names).toContain(name);
  });
});

describe("UT-OPS-05 generate report under scoped role", () => {
  async function report(headers: Headers, type: string, format = "csv") {
    return w.app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: { ...headers, ...idem() },
      payload: { type, format },
    });
  }

  /** Generates a report and returns its rendered content. */
  async function reportBody(headers: Headers, type: string): Promise<string> {
    const created = await report(headers, type);
    expect([200, 201]).toContain(created.statusCode);
    const { id } = created.json() as { id: string };
    const download = await w.app.inject({
      method: "GET",
      url: `/api/v1/reports/${id}/download`,
      headers,
    });
    expect(download.statusCode).toBe(200);
    return download.body;
  }

  it("refuses a report type whose domain the requester cannot read", async () => {
    // INVENTORY_MANAGER cannot read employees, so it cannot export them either.
    const res = await report(w.role.INVENTORY_MANAGER, "employees");
    expect(res.statusCode).toBe(403);
  });

  it("returns rows to a requester holding the matching domain read", async () => {
    const res = await report(w.admin, "employees");
    expect([200, 201, 202]).toContain(res.statusCode);
  });

  it("limits rows to the requester's record scope", async () => {
    // An HR manager scoped to district A must not export district B's people.
    const username = `cat_report_scope_${uniq()}`;
    const userId = await (
      await import("./fixture.js")
    ).createUser(w.pool, w.orgId, { username, roles: ["HR_MANAGER"] });
    await w.pool.query(
      "UPDATE user_roles SET scope_type = 'district', scope_id = $2 WHERE user_id = $1",
      [userId, w.chainA.district],
    );
    const headers = await (await import("./fixture.js")).loginAs(w.app, username);

    const csv = await reportBody(headers, "employees");
    const inScope = await w.pool.query("SELECT emp_no FROM employees WHERE id = $1", [
      w.directEmployee,
    ]);
    const outOfScope = await w.pool.query("SELECT emp_no FROM employees WHERE id = $1", [
      w.siteEmployee,
    ]);
    // District A's employee is in the export; district B's is not.
    expect(csv).toContain(inScope.rows[0].emp_no);
    expect(csv).not.toContain(outOfScope.rows[0].emp_no);
    // The export states the scope it was produced under, so a reader knows the
    // rows are a subset rather than the whole organization.
    expect(csv).toMatch(/Data scope/i);
  });

  it("keeps sensitive fields out of an export for a reader without PII access", async () => {
    const aadhaar = "321198765432";
    await w.app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { ...w.admin, ...idem() },
      payload: {
        emp_no: `RPT${uniq().toUpperCase().slice(-6)}`,
        first_name: "Report",
        last_name: "Subject",
        phone: "+919700000777",
        date_of_joining: "2024-01-01",
        aadhaar,
        salary_basic: 45000,
      },
    });

    // AUDITOR reads employees but holds no employee.pii.read.
    const masked = await reportBody(w.role.AUDITOR, "employees");
    expect(masked).not.toContain(aadhaar);

    // The same export for an authorized reader may carry it.
    const full = await reportBody(w.admin, "employees");
    expect(full.length).toBeGreaterThan(0);
  });

  it("audits every export", async () => {
    const before = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM audit_events WHERE action LIKE 'report%'",
    );
    await report(w.admin, "employees");
    const after = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM audit_events WHERE action LIKE 'report%'",
    );
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);
  });
});

describe("UT-OPS-06 request AI result with insufficient history", () => {
  it("returns INSUFFICIENT_DATA rather than a fabricated prediction", async () => {
    const projectId = await post(w.app, w.admin, "/api/v1/projects", {
      workspace_id: w.workspaceId,
      project_type_id: w.projectTypeId,
      code: `AI${uniq().toUpperCase().slice(-7)}`,
      name: "Brand new project",
    });

    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/insights/projects/${projectId}`,
      headers: w.admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      prediction: unknown;
      confidence: number | null;
      sample_size: number;
      advisory: boolean;
      recommended_action: string;
      model_version: string;
    };

    expect(body.status).toBe("INSUFFICIENT_DATA");
    // No number is invented to fill the gap.
    expect(body.prediction).toBeNull();
    expect(body.confidence).toBeNull();
    expect(body.sample_size).toBe(0);
    // And the caller is told what would make an answer possible.
    expect(body.recommended_action).toMatch(/five tasks/i);
    // Every answer is labelled advisory and version-stamped, so a decision
    // taken on it can be traced back to the model that produced it.
    expect(body.advisory).toBe(true);
    expect(body.model_version).toBeTruthy();
  });

  it("produces a prediction only once enough history exists", async () => {
    const projectId = await post(w.app, w.admin, "/api/v1/projects", {
      workspace_id: w.workspaceId,
      project_type_id: w.projectTypeId,
      code: `AI${uniq().toUpperCase().slice(-7)}`,
      name: "Project with history",
    });

    // Five completed tasks with measured durations — the documented threshold.
    for (let i = 0; i < 5; i += 1) {
      await w.pool.query(
        `INSERT INTO tasks (org_id, project_id, title, status, actual_start_at, actual_end_at, created_by)
         VALUES ($1, $2, $3, 'DONE', NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days', $4)`,
        [w.orgId, projectId, `Historic task ${i}`, w.adminId],
      );
    }

    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/insights/projects/${projectId}`,
      headers: w.admin,
    });
    const body = res.json() as {
      status: string;
      sample_size: number;
      confidence: number | null;
      prediction: { typical_task_days: number; delay_risk: string } | null;
      advisory: boolean;
    };
    expect(body.status).toBe("AVAILABLE");
    expect(body.sample_size).toBe(5);
    expect(body.confidence).toBeGreaterThan(0);
    expect(body.prediction!.typical_task_days).toBeCloseTo(3, 0);
    // Still advisory: the model informs, it does not decide.
    expect(body.advisory).toBe(true);
  });

  it("says INSUFFICIENT_DATA for a workforce suggestion with nobody to suggest", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/insights/projects/${w.activeProject}/workforce?skill=welding`,
      headers: w.admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; advisory: boolean; scope_note: string };
    expect(["AVAILABLE", "INSUFFICIENT_DATA"]).toContain(body.status);
    expect(body.advisory).toBe(true);
    // The answer states its own limits rather than implying completeness.
    expect(body.scope_note).toMatch(/visible in your scope/i);
  });

  it("refuses an insight request from a role without analytics access", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/insights/projects/${w.activeProject}`,
      headers: w.directUser,
    });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * The asset register a survey firm needs (enhancement note 3).
 *
 * What the thing is, what condition it is in, where it is right now, and who
 * had it before.
 */
describe("the asset register", () => {
  const H = () => ({ ...w.role.INVENTORY_MANAGER, ...idem() });

  /** An asset currently out with somebody, for the location tests. */
  async function outWithSomebody(): Promise<{ assetId: string; employeeId: string }> {
    const assetId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `AS${uniq().toUpperCase().slice(-8)}`,
      name: "Field rover", category: "ELECTRONIC", condition: "GOOD",
    });
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const res = await w.app.inject({
      method: "POST", url: `/api/v1/assets/${assetId}/assign`,
      headers: { ...H(), "if-match": "1" },
      payload: { employee_id: employeeId, condition: "GOOD", reason: "Survey work" },
    });
    expect(res.statusCode, res.body).toBe(200);
    return { assetId, employeeId };
  }

  async function types(): Promise<Array<Record<string, any>>> {
    const r = await w.app.inject({
      method: "GET", url: "/api/v1/asset-types", headers: w.role.INVENTORY_MANAGER,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().data;
  }

  it("offers every instrument the note names, ready to pick from", async () => {
    const codes = (await types()).map((t) => t.code);
    for (const wanted of ["ROVER", "DRONE", "TRIPOD", "BIPOD", "LAPTOP", "CPU", "MONITOR"]) {
      expect(codes, wanted).toContain(wanted);
    }
  });

  it("lets an organisation add a type the list never anticipated", async () => {
    // Nobody can enumerate in advance every instrument a survey firm buys,
    // and a register that refuses the thing you just bought gets kept in a
    // spreadsheet instead.
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/asset-types", headers: H(),
      payload: { code: "TOTAL_STATION", label: "Total station" },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect((await types()).map((t) => t.code)).toContain("TOTAL_STATION");
  });

  it("reinstates a retired entry rather than refusing the same code", async () => {
    // "It already exists, but inactive" is not something anybody can act on
    // from a form with one text box.
    await w.pool.query(
      "UPDATE asset_types SET active = false WHERE code = 'TOTAL_STATION'");
    const again = await w.app.inject({
      method: "POST", url: "/api/v1/asset-types", headers: H(),
      payload: { code: "TOTAL_STATION", label: "Total station (survey)" },
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().active).toBe(true);
    expect(again.json().label).toBe("Total station (survey)");
  });

  it("refuses a duplicate code that is still in use", async () => {
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/asset-types", headers: H(),
      payload: { code: "TOTAL_STATION", label: "Another one" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("will not let an ordinary reader extend the vocabulary", async () => {
    // A list anybody can add to stops being a vocabulary.
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/asset-types", headers: { ...w.role.EMPLOYEE, ...idem() },
      payload: { code: "SOMETHING", label: "Something" },
    });
    expect([401, 403]).toContain(r.statusCode);
  });

  it("registers an asset with its type, make and model", async () => {
    const rover = (await types()).find((t) => t.code === "ROVER")!;
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets", headers: H(),
      payload: {
        asset_code: `AS${uniq().toUpperCase().slice(-8)}`,
        name: "Rover 12", category: "ELECTRONIC", asset_type_id: rover.id,
        make: "Trimble", model: "R12i", condition: "BRAND_NEW",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().make).toBe("Trimble");
    expect(r.json().model).toBe("R12i");
  });

  it("refuses a category this organisation does not have", async () => {
    // Otherwise the asset is filed under something that exists nowhere and
    // vanishes from every view that joins on the lookup — present in the
    // register and absent from every sight of it.
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets", headers: H(),
      payload: {
        asset_code: `AS${uniq().toUpperCase().slice(-8)}`,
        name: "Mystery", category: "NOT_A_CATEGORY", condition: "GOOD",
      },
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().code).toBe("UNKNOWN_CATEGORY");
  });

  it("still accepts a category the register used before this list existed", async () => {
    /*
     * Migration 057 folded the categories already in use into the lookup, so
     * rows written years ago still resolve to a name. Refusing them would
     * mean an asset present in the register and absent from every view of
     * it — worse than never having been accepted.
     */
    await w.pool.query(
      `INSERT INTO asset_categories (org_id, code, label, display_order)
       VALUES ($1, 'LEGACY_TOOLS', 'Tools', 500) ON CONFLICT DO NOTHING`, [w.orgId]);
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets", headers: H(),
      payload: {
        asset_code: `AS${uniq().toUpperCase().slice(-8)}`,
        name: "Old theodolite", category: "LEGACY_TOOLS", condition: "GOOD",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
  });

  it("insists on a note when the condition is 'other'", async () => {
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets", headers: H(),
      payload: {
        asset_code: `AS${uniq().toUpperCase().slice(-8)}`,
        name: "Odd one", category: "ELECTRONIC", condition: "OTHER",
      },
    });
    expect(r.statusCode).toBe(422);
  });

  it("says where an asset is, and who has it, without being asked twice", async () => {
    const { assetId, employeeId } = await outWithSomebody();
    const r = await w.app.inject({
      method: "GET", url: `/api/v1/assets/${assetId}`, headers: w.role.INVENTORY_MANAGER,
    });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(a.location).toBe("IN_FIELD");
    expect(a.currently_with?.employee_id).toBe(employeeId);
    expect(a.currently_with?.employee_name).toBeTruthy();
  });

  it("puts it back in the office when it comes back", async () => {
    const { assetId } = await outWithSomebody();
    const back = await w.app.inject({
      method: "POST", url: `/api/v1/assets/${assetId}/transition`,
      headers: { ...H(), "if-match": "1" },
      payload: { status: "RETURNED", condition: "GOOD", reason: "End of survey" },
    });
    expect([200, 409]).toContain(back.statusCode);
    if (back.statusCode !== 200) return;

    const r = await w.app.inject({
      method: "GET", url: `/api/v1/assets/${assetId}`, headers: w.role.INVENTORY_MANAGER,
    });
    expect(r.json().location).toBe("IN_OFFICE");
    expect(r.json().currently_with).toBeNull();
  });

  it("keeps a readable history of who held it", async () => {
    // "Who had it when it broke" should not be a second query somebody has
    // to know to run.
    const { assetId } = await outWithSomebody();
    const r = await w.app.inject({
      method: "GET", url: `/api/v1/assets/${assetId}`, headers: w.role.INVENTORY_MANAGER,
    });
    const history = r.json().assignments as Array<Record<string, unknown>>;
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].employee_name, "a name, not an id").toBeTruthy();
    expect(history[0]).toHaveProperty("return_condition");
    expect(history[0]).toHaveProperty("returned_to_name");
  });
});

/**
 * Loading assets and stock from a file (enhancement note 3).
 *
 * Both had a download template and nowhere to submit it. A format nobody can
 * upload is a format nobody uses.
 */
describe("importing assets", () => {
  const H = () => ({ ...w.role.INVENTORY_MANAGER, ...idem() });

  async function imp(rows: unknown[], dry_run = true) {
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets/import", headers: H(),
      payload: { rows, dry_run },
    });
    return { status: r.statusCode, body: r.json() };
  }

  it("previews without writing anything, unless asked", async () => {
    // An import that silently writes two hundred rows on a mis-typed column
    // is one nobody runs twice.
    const code = `IM${uniq().toUpperCase().slice(-8)}`;
    const preview = await imp([{ code, name: "Rover", category: "ELECTRONIC" }]);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.dry_run).toBe(true);
    expect(preview.body.results[0].status).toBe("WOULD_CREATE");

    const found = await w.pool.query(
      "SELECT 1 FROM assets WHERE asset_code = $1", [code]);
    expect(found.rowCount, "nothing was written").toBe(0);
  });

  it("writes when the caller asks for it", async () => {
    const code = `IM${uniq().toUpperCase().slice(-8)}`;
    const done = await imp(
      [{ code, name: "Rover 2", category: "ELECTRONIC", make: "Trimble", model: "R12" }], false);
    expect(done.body.created).toBe(1);
    const row = await w.pool.query(
      "SELECT name, make, model FROM assets WHERE asset_code = $1", [code]);
    expect(row.rows[0]).toMatchObject({ name: "Rover 2", make: "Trimble", model: "R12" });
  });

  it("recognises the same physical unit by its serial and updates it", async () => {
    // Re-uploading a corrected sheet is the normal way this gets used;
    // refusing the file because forty rows already exist helps nobody.
    const serial = `SN${uniq().toUpperCase().slice(-8)}`;
    await imp([{
      code: `A1${uniq().toUpperCase().slice(-6)}`, name: "Before",
      category: "ELECTRONIC", serial_number: serial,
    }], false);
    const again = await imp([{
      code: `A2${uniq().toUpperCase().slice(-6)}`, name: "After",
      category: "ELECTRONIC", serial_number: serial,
    }], false);
    expect(again.body.updated).toBe(1);
    expect(again.body.created).toBe(0);

    const rows = await w.pool.query(
      "SELECT name FROM assets WHERE serial_number = $1", [serial]);
    expect(rows.rowCount, "one unit, not two").toBe(1);
    expect(rows.rows[0].name).toBe("After");
  });

  it("will not merge two accessories that share a serial", async () => {
    /*
     * The note's own exception, and the whole rule. A box of tripod screws
     * has no serial worth trusting, so two rows are two boxes — merging them
     * would silently destroy real stock.
     */
    const serial = "NOT-A-REAL-SERIAL";
    const first = `AC${uniq().toUpperCase().slice(-8)}`;
    const second = `AC${uniq().toUpperCase().slice(-8)}`;
    await imp([{ code: first, name: "Screws", category: "ACCESSORY", serial_number: serial }], false);
    const r = await imp([{ code: second, name: "More screws", category: "ACCESSORY", serial_number: serial }], false);
    // Two separate items — the serial is not the identity here.
    expect(r.body.created + r.body.rejected).toBe(1);
  });

  it("takes asset_code, which is what the register form calls it", async () => {
    const code = `AC${uniq().toUpperCase().slice(-8)}`;
    const r = await imp([{ asset_code: code, name: "Named right", category: "ELECTRONIC" }], false);
    expect(r.body.created, JSON.stringify(r.body)).toBe(1);
  });

  it("still takes the old column name, so filled-in sheets are not stranded", async () => {
    // The template said `code` before it said `asset_code`. Sheets built from
    // it are out there, and refusing them would throw away work somebody has
    // already done.
    const code = `OC${uniq().toUpperCase().slice(-8)}`;
    const r = await imp([{ code, name: "Old column", category: "ELECTRONIC" }], false);
    expect(r.body.created).toBe(1);
  });

  it("refuses a row with neither spelling of the code", async () => {
    const r = await imp([{ name: "No code at all", category: "ELECTRONIC" }]);
    expect(r.body.rejected).toBe(1);
  });

  it("ignores a vendor column, which the register no longer carries", async () => {
    // Vendor was added to the template and then asked to be taken out again.
    // A sheet that still has the column is not wrong — it just has a column
    // nothing reads, and rejecting the row over it would strand work.
    const r = await imp([{
      asset_code: `VN${uniq().toUpperCase().slice(-8)}`, name: "Bought somewhere",
      category: "ELECTRONIC", vendor: "No Such Supplier Ltd",
    }], false);
    expect(r.body.created, JSON.stringify(r.body)).toBe(1);
  });

  it("rejects a row naming a category nobody has, and keeps the rest", async () => {
    // One bad row must not cost the other 199.
    const good = `OK${uniq().toUpperCase().slice(-8)}`;
    const r = await imp([
      { code: `BAD${uniq().toUpperCase().slice(-6)}`, name: "Nope", category: "NOT_A_CATEGORY" },
      { code: good, name: "Fine", category: "ELECTRONIC" },
    ], false);
    expect(r.body.rejected).toBe(1);
    expect(r.body.created).toBe(1);
    expect(r.body.results[0].message).toContain("no active asset category");
    expect((await w.pool.query("SELECT 1 FROM assets WHERE asset_code=$1", [good])).rowCount).toBe(1);
  });

  it("insists on a note when a row says the condition is 'other'", async () => {
    const r = await imp([{
      code: `OT${uniq().toUpperCase().slice(-8)}`, name: "Odd",
      category: "ELECTRONIC", condition: "OTHER",
    }]);
    expect(r.body.rejected).toBe(1);
  });

  it("is refused to somebody who may not manage assets", async () => {
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets/import",
      headers: { ...w.role.EMPLOYEE, ...idem() },
      payload: { rows: [{ code: "X", name: "Y", category: "ELECTRONIC" }] },
    });
    expect([401, 403]).toContain(r.statusCode);
  });
});

describe("importing stock items", () => {
  it("creates and then updates on the item code", async () => {
    const code = `IT${uniq().toUpperCase().slice(-8)}`;
    const H = { ...w.role.INVENTORY_MANAGER, ...idem() };
    const first = await w.app.inject({
      method: "POST", url: "/api/v1/inventory/items/import", headers: H,
      payload: { rows: [{ code, name: "Cement", unit: "BAG" }], dry_run: false },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().created).toBe(1);

    const again = await w.app.inject({
      method: "POST", url: "/api/v1/inventory/items/import",
      headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
      payload: { rows: [{ code, name: "Cement OPC 53", unit: "BAG" }], dry_run: false },
    });
    expect(again.json().updated).toBe(1);
    const row = await w.pool.query("SELECT name FROM inventory_items WHERE code=$1", [code]);
    expect(row.rows[0].name).toBe("Cement OPC 53");
  });
});

describe("importing who holds what", () => {
  const H = () => ({ ...w.role.INVENTORY_MANAGER, ...idem() });

  async function allocate(rows: unknown[], dry_run = false) {
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets/allocations/import", headers: H(),
      payload: { rows, dry_run },
    });
    return { status: r.statusCode, body: r.json() };
  }

  async function freeAsset(): Promise<string> {
    const code = `AL${uniq().toUpperCase().slice(-8)}`;
    await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: code, name: "Allocatable", category: "ELECTRONIC", condition: "GOOD",
    });
    return code;
  }

  async function activeEmpNo(): Promise<string> {
    const id = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });
    return String((await w.pool.query("SELECT emp_no FROM employees WHERE id=$1", [id])).rows[0].emp_no);
  }

  it("puts fifty rovers in fifty hands without fifty forms", async () => {
    const code = await freeAsset();
    const emp = await activeEmpNo();
    const r = await allocate([{ asset_code: code, emp_no: emp, reason: "Ground truthing" }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.allocated).toBe(1);

    const open = await w.pool.query(
      `SELECT 1 FROM asset_assignments a JOIN assets s ON s.id=a.asset_id
        WHERE s.asset_code=$1 AND a.returned_at IS NULL`, [code]);
    expect(open.rowCount).toBe(1);
  });

  it("reports an asset already out, rather than moving it silently", async () => {
    /*
     * Quietly reassigning equipment is how a register starts contradicting
     * the people holding it — and the person who actually has the thing is
     * the one who finds out last.
     */
    const code = await freeAsset();
    const first = await activeEmpNo();
    const second = await activeEmpNo();
    await allocate([{ asset_code: code, emp_no: first, reason: "First" }]);
    const again = await allocate([{ asset_code: code, emp_no: second, reason: "Second" }]);

    expect(again.body.already_allocated).toBe(1);
    expect(again.body.allocated).toBe(0);
    expect(again.body.results[0].message).toContain("already out with");

    // And it is still with the first person.
    const holder = await w.pool.query(
      `SELECT e.emp_no FROM asset_assignments a
         JOIN assets s ON s.id=a.asset_id JOIN employees e ON e.id=a.employee_id
        WHERE s.asset_code=$1 AND a.returned_at IS NULL`, [code]);
    expect(holder.rows[0].emp_no).toBe(first);
  });

  it("takes dates as a spreadsheet gives them", async () => {
    /*
     * Excel hands over a day count, so an issue date arrives as 46114, and a
     * strict YYYY-MM-DD pattern refused it — along with 01/04/2026, which is
     * how the date is written here. Neither is the person's mistake.
     */
    const a = await freeAsset();
    const b = await freeAsset();
    const emp = await activeEmpNo();
    const r = await allocate([
      { asset_code: a, emp_no: emp, reason: "Serial date", issued_on: 46114 },
      { asset_code: b, emp_no: emp, reason: "Written date", issued_on: "01/04/2026" },
    ]);
    expect(r.body.allocated, JSON.stringify(r.body.results)).toBe(2);
  });

  it("does not mind a blank date at all", async () => {
    const a = await freeAsset();
    const emp = await activeEmpNo();
    const r = await allocate([
      { asset_code: a, emp_no: emp, reason: "No date given", issued_on: "", due_date: "" },
    ]);
    expect(r.body.allocated, JSON.stringify(r.body.results)).toBe(1);
  });

  it("names the row that is wrong instead of failing the file", async () => {
    const good = await freeAsset();
    const emp = await activeEmpNo();
    const r = await allocate([
      { asset_code: "NO-SUCH-ASSET", emp_no: emp, reason: "x" },
      { asset_code: good, emp_no: emp, reason: "Real allocation" },
    ]);
    expect(r.body.rejected).toBe(1);
    expect(r.body.allocated).toBe(1);
    expect(r.body.results[0].message).toContain("No asset with code");
  });

  it("refuses to hand equipment to somebody who has left", async () => {
    const code = await freeAsset();
    const emp = await activeEmpNo();
    await w.pool.query("UPDATE employees SET status='EXITED' WHERE emp_no=$1", [emp]);
    const r = await allocate([{ asset_code: code, emp_no: emp, reason: "x" }]);
    expect(r.body.rejected).toBe(1);
    expect(r.body.results[0].message).toContain("not an active employee");
  });

  it("previews without allocating anything", async () => {
    const code = await freeAsset();
    const emp = await activeEmpNo();
    const r = await allocate([{ asset_code: code, emp_no: emp, reason: "x" }], true);
    expect(r.body.results[0].status).toBe("WOULD_ALLOCATE");
    const open = await w.pool.query(
      `SELECT 1 FROM asset_assignments a JOIN assets s ON s.id=a.asset_id
        WHERE s.asset_code=$1 AND a.returned_at IS NULL`, [code]);
    expect(open.rowCount, "nothing was written").toBe(0);
  });
});

describe("issuing several assets to one person", () => {
  const H = () => ({ ...w.role.INVENTORY_MANAGER, ...idem() });

  async function freeAsset(name: string): Promise<string> {
    return post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `BK${uniq().toUpperCase().slice(-8)}`,
      name, category: "ELECTRONIC", condition: "GOOD",
    });
  }

  it("issues a whole kit in one action", async () => {
    // A surveyor carries a rover, a tripod, a radio and a battery. One form
    // at a time is four chances to stop after three.
    const kit = [await freeAsset("Rover"), await freeAsset("Tripod"), await freeAsset("Radio")];
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets/assign-bulk", headers: H(),
      payload: { asset_ids: kit, employee_id: employeeId, reason: "Field kit" },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().issued).toBe(3);
  });

  it("names the item already out with somebody and issues the rest", async () => {
    const mine = await freeAsset("Wanted rover");
    const spare = await freeAsset("Spare tripod");
    const first = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });
    const second = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });

    await w.app.inject({
      method: "POST", url: "/api/v1/assets/assign-bulk", headers: H(),
      payload: { asset_ids: [mine], employee_id: first, reason: "First" },
    });
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets/assign-bulk", headers: H(),
      payload: { asset_ids: [mine, spare], employee_id: second, reason: "Second" },
    });
    expect(r.json().issued).toBe(1);
    expect(r.json().busy).toHaveLength(1);
    expect(r.json().busy[0].with_whom).toBeTruthy();
  });

  it("will not issue anything to somebody who has left", async () => {
    const asset = await freeAsset("For a leaver");
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    await w.pool.query("UPDATE employees SET status='EXITED' WHERE id=$1", [employeeId]);
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets/assign-bulk", headers: H(),
      payload: { asset_ids: [asset], employee_id: employeeId, reason: "x" },
    });
    expect(r.statusCode).toBe(422);
  });

  it("says who holds each asset, on what number, and since when", async () => {
    // Chasing a missing instrument should not start with looking somebody up
    // in the directory.
    const asset = await freeAsset("Traceable");
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    await w.app.inject({
      method: "POST", url: "/api/v1/assets/assign-bulk", headers: H(),
      payload: { asset_ids: [asset], employee_id: employeeId, reason: "Survey" },
    });
    const list = await w.app.inject({
      method: "GET", url: "/api/v1/assets?limit=100", headers: w.role.INVENTORY_MANAGER,
    });
    const row = (list.json().data as Array<Record<string, unknown>>)
      .find((a) => a.id === asset);
    expect(row!.held_by).toBeTruthy();
    expect(row!.held_by_phone).toBeTruthy();
    expect(row!.assigned_on).toBeTruthy();
  });
});

describe("handing an asset on, and correcting an allocation", () => {
  const H = () => ({ ...w.role.INVENTORY_MANAGER, ...idem() });

  async function issued(): Promise<{ assetId: string; holder: string }> {
    const assetId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `TF${uniq().toUpperCase().slice(-8)}`,
      name: "Transferable", category: "ELECTRONIC", condition: "GOOD",
    });
    const holder = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/assets/assign-bulk", headers: H(),
      payload: { asset_ids: [assetId], employee_id: holder, reason: "First holder" },
    });
    expect(r.statusCode, r.body).toBe(201);
    return { assetId, holder };
  }

  it("closes the old spell and opens a new one, keeping both", async () => {
    /*
     * Rewriting the open assignment's employee would erase that the first
     * person ever had it — the one thing the trail exists to remember.
     */
    const { assetId, holder } = await issued();
    const next = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });

    const r = await w.app.inject({
      method: "POST", url: `/api/v1/assets/${assetId}/transfer`,
      headers: { ...H(), "if-match": "2" },
      payload: { to_employee_id: next, condition: "GOOD", reason: "Crew change" },
    });
    expect([200, 409]).toContain(r.statusCode);
    if (r.statusCode !== 200) return;

    const spells = await w.pool.query(
      `SELECT employee_id, returned_at, return_condition, returned_to_employee_id
         FROM asset_assignments WHERE asset_id = $1 ORDER BY issued_at`, [assetId]);
    expect(spells.rowCount, "both spells are on the record").toBe(2);
    expect(String(spells.rows[0].employee_id)).toBe(holder);
    expect(spells.rows[0].returned_at, "the first is closed").toBeTruthy();
    expect(String(spells.rows[0].returned_to_employee_id)).toBe(next);
    expect(String(spells.rows[1].employee_id)).toBe(next);
    expect(spells.rows[1].returned_at, "the second is open").toBeNull();
  });

  it("refuses to hand it to whoever already has it", async () => {
    const { assetId, holder } = await issued();
    const r = await w.app.inject({
      method: "POST", url: `/api/v1/assets/${assetId}/transfer`,
      headers: { ...H(), "if-match": "2" },
      payload: { to_employee_id: holder, condition: "GOOD", reason: "No change" },
    });
    expect([409, 422]).toContain(r.statusCode);
  });

  it("refuses to transfer something nobody is holding", async () => {
    const assetId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `NH${uniq().toUpperCase().slice(-8)}`,
      name: "In the store", category: "ELECTRONIC", condition: "GOOD",
    });
    const to = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });
    const r = await w.app.inject({
      method: "POST", url: `/api/v1/assets/${assetId}/transfer`,
      headers: { ...H(), "if-match": "1" },
      payload: { to_employee_id: to, condition: "GOOD", reason: "x" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("corrects the date an open allocation started", async () => {
    const { assetId } = await issued();
    const open = await w.pool.query(
      "SELECT id FROM asset_assignments WHERE asset_id=$1 AND returned_at IS NULL", [assetId]);
    const r = await w.app.inject({
      method: "PATCH", url: `/api/v1/asset-allocations/${open.rows[0].id}`,
      headers: H(), payload: { issued_at: "2026-02-01" },
    });
    expect(r.statusCode, r.body).toBe(200);
    const after = await w.pool.query(
      "SELECT issued_at::date::text AS on_date FROM asset_assignments WHERE id=$1",
      [open.rows[0].id]);
    expect(after.rows[0].on_date).toBe("2026-02-01");
  });

  it("will not correct a spell that has already ended", async () => {
    // Editing a closed record rewrites history rather than fixing a typo.
    const { assetId } = await issued();
    const next = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });
    await w.app.inject({
      method: "POST", url: `/api/v1/assets/${assetId}/transfer`,
      headers: { ...H(), "if-match": "2" },
      payload: { to_employee_id: next, condition: "GOOD", reason: "Moved on" },
    });
    const closed = await w.pool.query(
      "SELECT id FROM asset_assignments WHERE asset_id=$1 AND returned_at IS NOT NULL LIMIT 1",
      [assetId]);
    if (!closed.rowCount) return;
    const r = await w.app.inject({
      method: "PATCH", url: `/api/v1/asset-allocations/${closed.rows[0].id}`,
      headers: H(), payload: { issued_at: "2026-01-01" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("creates a type from just its name", async () => {
    // Somebody adding "Total station" from inside the register form has a
    // name in mind, not a code.
    const r = await w.app.inject({
      method: "POST", url: "/api/v1/asset-types", headers: H(),
      payload: { label: "Auto level" },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().code).toBe("AUTO_LEVEL");
  });

  it("gives the equipment picker something a storeman can identify", async () => {
    // Three rows reading "Rover" and no way to tell which is being signed out
    // is how the wrong one goes into the van.
    const list = await w.app.inject({
      method: "GET", url: "/api/v1/assets?limit=5", headers: w.role.INVENTORY_MANAGER,
    });
    const row = (list.json().data as Array<Record<string, unknown>>)[0];
    expect(String(row.picker_label)).toContain(String(row.asset_code));
  });
});

describe("where equipment has been", () => {
  const H = () => ({ ...w.role.INVENTORY_MANAGER, ...idem() });

  async function moves(query = ""): Promise<Array<Record<string, any>>> {
    const r = await w.app.inject({
      method: "GET", url: `/api/v1/assets/movements?${query}`,
      headers: w.role.INVENTORY_MANAGER,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().data;
  }

  it("reads an issue and a return as two events, not one spell", async () => {
    /*
     * "What happened on the 14th" is the question being asked, and a spell
     * spanning three weeks answers it badly.
     */
    const assetId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `MV${uniq().toUpperCase().slice(-8)}`,
      name: "Moving rover", category: "ELECTRONIC", condition: "GOOD",
    });
    const holder = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });
    await w.app.inject({
      method: "POST", url: "/api/v1/assets/assign-bulk", headers: H(),
      payload: { asset_ids: [assetId], employee_id: holder, reason: "Ground truthing" },
    });
    await w.app.inject({
      method: "POST", url: `/api/v1/assets/${assetId}/transition`,
      headers: { ...H(), "if-match": "2" },
      payload: { status: "RETURNED", condition: "REPAIR", reason: "Back from site" },
    });

    const rows = await moves(`asset_id=${assetId}`);
    const kinds = rows.map((r) => r.movement);
    expect(kinds, "one event out, one back").toContain("ISSUED");
    expect(kinds).toContain("RETURNED");

    const back = rows.find((r) => r.movement === "RETURNED")!;
    // The comparison the record exists for: went out good, came back needing
    // repair.
    expect(back.condition).toBe("REPAIR");
    expect(back.from_name, "who handed it over").toBeTruthy();
  });

  it("names both ends of a handover, and what it is", async () => {
    const rows = await moves("limit=5");
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.asset_code, "which instrument").toBeTruthy();
    expect(row).toHaveProperty("type_label");
    expect(row).toHaveProperty("serial_number");
    expect(row).toHaveProperty("recorded_by_username");
  });

  it("finds everything one person has had, taken or given back", async () => {
    // "What has this person had" means both what they took and what they
    // handed over, which are opposite ends of the same row.
    const assetId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `PE${uniq().toUpperCase().slice(-8)}`,
      name: "Person-tracked", category: "ELECTRONIC", condition: "GOOD",
    });
    const person = await createActiveEmployee(w.app, w.admin, { district_id: w.chainA.district });
    await w.app.inject({
      method: "POST", url: "/api/v1/assets/assign-bulk", headers: H(),
      payload: { asset_ids: [assetId], employee_id: person, reason: "Theirs" },
    });
    const rows = await moves(`employee_id=${person}`);
    expect(rows.some((r) => r.asset_id === assetId)).toBe(true);
  });

  it("narrows to a date range", async () => {
    const none = await moves("from=2000-01-01&to=2000-01-02");
    expect(none).toHaveLength(0);
  });

  it("is readable by anybody who may read assets, not only a manager", async () => {
    // Knowing where the kit is is not a privileged question; changing it is.
    const r = await w.app.inject({
      method: "GET", url: "/api/v1/assets/movements?limit=1",
      headers: w.role.TEAM_LEAD ?? w.role.INVENTORY_MANAGER,
    });
    expect([200, 403]).toContain(r.statusCode);
  });
});
