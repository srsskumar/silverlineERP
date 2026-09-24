/**
 * Scale round (2026-09-24, findings-integrity.md): the heaviest list
 * endpoints against a seeded ~10k-row world, limit caps, special characters
 * in search, and a 5000-row export. Timings are printed so the report can
 * quote them; the thresholds are generous and only catch a query that has
 * gone quadratic.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, uniq, type CatalogueWorld } from "./fixture.js";

let w: CatalogueWorld;
const timings: Record<string, number> = {};

async function timed(label: string, url: string) {
  const t0 = performance.now();
  const res = await w.app.inject({ method: "GET", url, headers: w.admin });
  timings[label] = Math.round(performance.now() - t0);
  return res;
}

beforeAll(async () => {
  w = await buildWorld();
  const tag = uniq("SC");
  await w.pool.query(
    `INSERT INTO inventory_items(org_id, code, name, unit)
     SELECT $1, $2 || g, 'Scale item ' || g, 'KG' FROM generate_series(1, 1000) g`, [w.orgId, tag]);
  await w.pool.query(
    `INSERT INTO stock_transactions(org_id, item_id, direction, quantity, reference, transaction_type, created_by)
     SELECT $1, i.id, 'IN', 1, 'scale', 'PURCHASE_RECEIPT', $3::uuid
       FROM inventory_items i CROSS JOIN generate_series(1, 20) g
      WHERE i.org_id = $1 AND i.code LIKE $2 || '%'`, [w.orgId, tag, w.adminId]);
  await w.pool.query(
    `INSERT INTO payments(org_id, payment_no, direction, paid_on, amount, mode)
     SELECT $1, $2 || g, 'PAYABLE', DATE '2026-01-01' + (g % 200), 10, 'NEFT' FROM generate_series(1, 10000) g`,
    [w.orgId, tag]);
  await w.pool.query(
    `INSERT INTO employees(org_id, emp_no, first_name, last_name, phone, date_of_joining, status)
     SELECT $1, $2 || g, 'Scale', 'Person ' || g, '9' || lpad(g::text, 9, '0'), DATE '2024-01-01', 'ACTIVE'
       FROM generate_series(1, 5000) g`, [w.orgId, tag]);
  await w.pool.query(
    `INSERT INTO tasks(org_id, project_id, title)
     SELECT $1, $2, 'Scale task ' || g FROM generate_series(1, 10000) g`, [w.orgId, w.activeProject]);
  await w.pool.query("ANALYZE");
}, 300_000);

afterAll(async () => {
  console.log("SCALE TIMINGS (ms)", JSON.stringify(timings));
  await w.app.close(); await w.pool.end();
});

describe("heaviest lists at ~10k rows", () => {
  for (const [label, url] of [
    ["items", "/api/v1/inventory/items?limit=100"],
    ["payments", "/api/v1/payments?limit=100"],
    ["payments-deep", "/api/v1/payments?limit=100&offset=9800"],
    ["employees", "/api/v1/employees?limit=100"],
    ["employees-search", "/api/v1/employees?q=Person%204999"],
    ["tasks", `/api/v1/tasks?project_id=__P__&limit=100`],
    ["stock-transactions", "/api/v1/stock-transactions?limit=100"],
    ["inventory-transactions", "/api/v1/inventory/transactions?limit=100"],
    ["ap-ageing", "/api/v1/ap/ageing"],
  ] as const) {
    it(`${label} answers in under 3s`, async () => {
      const res = await timed(label, url.replace("__P__", w.activeProject));
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(timings[label]).toBeLessThan(3000);
    });
  }
});

describe("D-007 limit caps and hostile search strings", () => {
  it("caps an enormous limit", async () => {
    const res = await timed("payments-cap", "/api/v1/payments?limit=100000");
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).data.length).toBeLessThanOrEqual(100);
  });

  for (const q of ["%", "_", "'", "\\", "%_%", "'; DROP TABLE employees; --", "नमस्ते", "(", "[a-z]*"]) {
    it(`searches employees for ${JSON.stringify(q)} without a 500`, async () => {
      const res = await w.app.inject({ method: "GET", url: `/api/v1/employees?q=${encodeURIComponent(q)}`, headers: w.admin });
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    });
  }

  it("treats % in a search as a literal, not a wildcard", async () => {
    const res = await w.app.inject({ method: "GET", url: `/api/v1/employees?q=${encodeURIComponent("%")}&limit=100`, headers: w.admin });
    expect(res.statusCode).toBe(200);
    // No employee's name, number or phone contains a literal percent sign.
    expect((res.json() as any).data.length).toBe(0);
  });
});

describe("export at the synchronous ceiling", () => {
  it("renders a 5000-row employee export", async () => {
    const t0 = performance.now();
    const created = await w.app.inject({
      method: "POST", url: "/api/v1/reports",
      headers: { ...w.admin, "idempotency-key": crypto.randomUUID() },
      payload: { type: "employees", format: "csv" },
    });
    timings["export-employees"] = Math.round(performance.now() - t0);
    expect([200, 201, 202], created.body.slice(0, 300)).toContain(created.statusCode);
    expect(timings["export-employees"]).toBeLessThan(15000);
  });
});
