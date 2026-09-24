/**
 * R6 exhaustive API contract sweep -- cross-org depth.
 *
 * `route-matrix.test.ts` proves every route 404s (or a documented exception)
 * for a syntactically-valid but *nonexistent* uuid, uniformly across all 477
 * routes -- see findings-contract.md's "Explicitly out of this round's
 * depth" note. That exercises the same "no such row for this org" query
 * path a real cross-tenant leak would, but it does not prove a *specific*
 * row belonging to a real second organization is actually invisible.
 *
 * This file closes that gap for the major resource families beyond
 * `CatalogueWorld`'s original ~8 (employees, projects/tasks, payroll runs,
 * org unit chain, holiday, asset, item, vendor): leave, purchase orders,
 * payment runs, expense claims, documents, and reports, using the real
 * `world.other.*` rows `buildWorld()` now creates (fixture.ts, 2026-09-24).
 * Any 2xx here is a P0 -- a real record leaking across tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, type CatalogueWorld } from "../catalogue/fixture.js";

let w: CatalogueWorld;
beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("cross-org depth: a real org-B row is invisible to org-A", () => {
  for (const [label, urlOf] of [
    ["employee", () => `/api/v1/employees/${w.other.employee}`],
    ["leave request", () => `/api/v1/leave/requests/${w.other.leaveRequestId}`],
    ["payroll run", () => `/api/v1/payroll/runs/${w.other.payrollRunId}`],
    ["project", () => `/api/v1/projects/${w.other.projectId}`],
    ["task", () => `/api/v1/tasks/${w.other.taskId}`],
    ["purchase order", () => `/api/v1/purchase-orders/${w.other.purchaseOrderId}`],
    ["payment run", () => `/api/v1/payment-runs/${w.other.paymentRunId}`],
    ["expense claim", () => `/api/v1/expense-claims/${w.other.expenseClaimId}`],
    ["asset", () => `/api/v1/assets/${w.other.assetId}`],
    ["document", () => `/api/v1/documents/${w.other.documentId}`],
    ["report download", () => `/api/v1/reports/${w.other.reportId}/download`],
  ] as Array<[string, () => string]>) {
    it(`org-A admin gets 404 for org-B's real ${label}, never 2xx`, async () => {
      const res = await w.app.inject({ method: "GET", url: urlOf(), headers: w.admin });
      expect(res.statusCode, `${label}: org-B row must not be visible (got ${res.statusCode}) body=${res.body.slice(0, 300)}`).toBe(404);
    });
  }

  it("the reverse direction also holds: org-B admin gets 404 for org-A's real employee", async () => {
    const res = await w.app.inject({
      method: "GET", url: `/api/v1/employees/${w.directEmployee}`, headers: w.other.admin,
    });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * Not covered by a live row in this pass (documented, not silently skipped):
 *
 * - GRNs and vendor invoices -- both gate through the exact same `inOrg()`
 *   allow-listed lookup (common/domain.ts) the purchase order case above
 *   already proves org-scoped; reaching either needs the order to be
 *   APPROVED+SENT, which needs an approval policy this fixture does not
 *   seed for the second organization.
 * - Survey villages -- needs the programme-pairing and stage-pipeline setup
 *   (survey/routes.ts), out of this pass's budget.
 *
 * See findings-contract.md.
 */
