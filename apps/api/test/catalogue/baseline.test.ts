/**
 * Guards the catalogue's "Test data baseline" itself.
 *
 * Every other catalogue suite builds on this world, so when the baseline drifts
 * the failure should name the baseline rather than surfacing as a confusing
 * cascade in twenty unrelated business tests.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_CODES } from "@silverline/shared";
import { buildWorld, monthEnd, monthStart, type CatalogueWorld } from "./fixture.js";

let w: CatalogueWorld;

beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

describe("catalogue test data baseline", () => {
  it("provisions two organizations", async () => {
    expect(w.orgId).not.toEqual(w.other.adminId);
    expect(w.otherOrgId ?? w.other.admin).toBeDefined();
    const orgs = await w.pool.query("SELECT COUNT(*)::int AS n FROM organizations");
    expect(orgs.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("seeds every role code and can sign in as each", () => {
    for (const code of ROLE_CODES) {
      expect(w.role[code]?.authorization, `missing session for ${code}`).toMatch(/^Bearer /);
    }
  });

  it("builds two districts and two complete District→Mandal→Village→Site chains", async () => {
    expect(w.chainA.district).not.toEqual(w.chainB.district);
    for (const chain of [w.chainA, w.chainB]) {
      const rows = await w.pool.query(
        "SELECT id, type, parent_id FROM org_units WHERE id = ANY($1::uuid[])",
        [[chain.district, chain.mandal, chain.village, chain.site]],
      );
      expect(rows.rowCount).toBe(4);
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      expect(byId.get(chain.site)!.parent_id).toBe(chain.village);
      expect(byId.get(chain.village)!.parent_id).toBe(chain.mandal);
      expect(byId.get(chain.mandal)!.parent_id).toBe(chain.district);
      expect(byId.get(chain.district)!.parent_id).toBeNull();
    }
  });

  it("holds two active, one suspended and one exited employee", async () => {
    const rows = await w.pool.query(
      "SELECT id, status FROM employees WHERE id = ANY($1::uuid[])",
      [[w.directEmployee, w.siteEmployee, w.suspendedEmployee, w.exitedEmployee]],
    );
    const status = new Map(rows.rows.map((r) => [r.id, r.status]));
    expect(status.get(w.directEmployee)).toBe("ACTIVE");
    expect(status.get(w.siteEmployee)).toBe("ACTIVE");
    expect(status.get(w.suspendedEmployee)).toBe("SUSPENDED");
    expect(status.get(w.exitedEmployee)).toBe("EXITED");
  });

  it("puts each active employee on their own chain's site", async () => {
    const sites = await w.pool.query("SELECT id, site_id FROM employees WHERE id = ANY($1::uuid[])", [
      [w.directEmployee, w.siteEmployee],
    ]);
    const siteOf = new Map(sites.rows.map((r) => [r.id, r.site_id]));
    expect(siteOf.get(w.directEmployee)).toBe(w.chainA.site);
    expect(siteOf.get(w.siteEmployee)).toBe(w.chainB.site);
  });

  it("holds no geo-fences, because the product has none", async () => {
    const fences = await w.pool.query("SELECT COUNT(*)::int AS n FROM geo_fences WHERE org_id = $1", [
      w.orgId,
    ]);
    expect(fences.rows[0].n).toBe(0);
  });

  it("creates an active project with a configurable workflow and an inactive project", async () => {
    const rows = await w.pool.query(
      "SELECT id, status FROM projects WHERE id = ANY($1::uuid[])",
      [[w.activeProject, w.inactiveProject]],
    );
    const status = new Map(rows.rows.map((r) => [r.id, r.status]));
    expect(status.get(w.activeProject)).toBe("ACTIVE");
    expect(status.get(w.inactiveProject)).not.toBe("ACTIVE");

    const override = await w.pool.query(
      "SELECT project_id FROM project_workflow_overrides WHERE project_id = $1",
      [w.activeProject],
    );
    expect(override.rowCount).toBe(1);
  });

  it("opens a payroll period over the current month", async () => {
    const run = await w.pool.query(
      "SELECT status, period_start, period_end FROM payroll_runs WHERE id = $1",
      [w.payrollRunId],
    );
    expect(run.rows[0].status).toBe("OPEN");
    expect(String(run.rows[0].period_start).slice(0, 10)).toBe(monthStart());
    expect(String(run.rows[0].period_end).slice(0, 10)).toBe(monthEnd());
  });

  it("stocks exactly one unit of the probe item and leaves the asset available", async () => {
    const stock = await w.pool.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0) AS qty
         FROM stock_transactions WHERE item_id = $1`,
      [w.itemId],
    );
    expect(Number(stock.rows[0].qty)).toBe(1);

    const asset = await w.pool.query("SELECT status FROM assets WHERE id = $1", [w.assetId]);
    expect(asset.rows[0].status).toBe("AVAILABLE");
  });

  it("fixes the organization timezone to Asia/Kolkata", async () => {
    const org = await w.pool.query("SELECT timezone FROM organizations WHERE id = $1", [
      w.orgId,
    ]);
    expect(org.rows[0].timezone).toBe("Asia/Kolkata");
  });

  it("seeds leave balances for both active employees", async () => {
    const rows = await w.pool.query(
      "SELECT employee_id FROM leave_balances WHERE employee_id = ANY($1::uuid[])",
      [[w.directEmployee, w.siteEmployee]],
    );
    expect(rows.rowCount).toBe(2);
  });
});
