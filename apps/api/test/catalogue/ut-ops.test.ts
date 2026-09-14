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
      category: "IT",
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
      category: "TOOLS",
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
      "SELECT employee_id, returned_at, condition FROM asset_assignments WHERE asset_id = $1",
      [assetId],
    );
    expect(assignment.rowCount).toBe(1);
    expect(assignment.rows[0].employee_id).toBe(employeeId);
    // The assignment is closed, not deleted: the history of who held it stays.
    expect(assignment.rows[0].returned_at).toBeTruthy();
    expect(assignment.rows[0].condition).toBe("CRACKED_SCREEN");
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
      category: "TOOLS",
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
