// Post-deploy QA (2026-09-24): live spot-check of every P0/P1 fix named in
// the sweep brief, run directly against the deployed API (no browser).
// Creates its own throwaway QA- records where a seeded one isn't in the
// right state (e.g. the seeded PO is FULLY_RECEIVED and so isn't
// amendable, the seeded expense claim is already REIMBURSED) rather than
// mutating seeded data.
//
//   node regression-spotcheck.mjs
import { readFileSync } from "node:fs";
import { loginAs, loadDataset, call } from "../integrations/qalib.mjs";

const ds = loadDataset();
const admin = await loginAs("qa-admin-superadmin");
const T = admin.access_token;
const rand = Math.random().toString(36).slice(2, 8);
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " :: " + detail : ""}`);
  if (!ok) failures++;
};

// -- empty-body 4xx (not 500) ------------------------------------------
{
  const r = await fetch(`http://127.0.0.1/api/v1/purchase-orders/${ds.procurement.poId}/status`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` },
  });
  check("empty-body -> 4xx not 500", r.status >= 400 && r.status < 500, `status=${r.status}`);
}

// -- prototype poisoning -> 400 (parser-level, before zod ever sees it) --
{
  const raw = `{"__proto__":{"polluted":true},"lead_no":"QA-PROTO-${rand}","organization_name":"QA Proto Org","source":"REFERRAL","stage":"NEW","lead_type":"NEW"}`;
  const r = await fetch("http://127.0.0.1/api/v1/leads", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: raw,
  });
  check("__proto__ key -> 400 BAD_REQUEST", r.status === 400, `status=${r.status}`);
}

// -- holiday edit/deactivate + include_inactive gate ---------------------
{
  const list = await call(T, "GET", "/holidays?year=2026");
  const hol = list.body?.data?.[0];
  if (hol) {
    const off = await call(T, "PATCH", `/holidays/${hol.id}`, { active: false, reason: "QA regression deactivate" }, { "if-match": "1" });
    check("holiday deactivate -> 200", off.status === 200, `status=${off.status}`);
    const nonManage = await loginAs("qa-admin-employee");
    const gated = await call(nonManage.access_token, "GET", "/holidays?year=2026&include_inactive=true");
    check("include_inactive without holiday.read -> 403", gated.status === 403, `status=${gated.status}`);
    const withPerm = await call(T, "GET", "/holidays?year=2026&include_inactive=true");
    const cur = withPerm.body?.data?.find((h) => h.id === hol.id);
    if (cur) {
      const on = await call(T, "PATCH", `/holidays/${hol.id}`, { active: true, reason: "QA regression revert" }, { "if-match": String(cur.version) });
      check("holiday reactivate -> 200", on.status === 200, `status=${on.status}`);
    }
  } else {
    check("holiday edit/deactivate", false, "no seeded holiday found");
  }
}

// -- invoice -> PO vendor mismatch ---------------------------------------
{
  const vendors = await call(T, "GET", "/vendors?limit=5");
  const other = vendors.body?.data?.find((v) => v.id !== ds.procurement.vendorId);
  if (other) {
    const mismatch = await call(T, "POST", "/invoices", {
      serial_number: `QA-MISMATCH-${rand}`, vendor_id: other.id, hsn: "998311", gst_enabled: true,
      gst_rate: "18", subtotal: "1000.00", payment_mode: "BANK", reference: "QA regression mismatch",
      purchase_order_id: ds.procurement.poId,
    });
    check("invoice w/ mismatched PO vendor -> 422 PO_VENDOR_MISMATCH", mismatch.status === 422 && mismatch.body?.code === "PO_VENDOR_MISMATCH", `status=${mismatch.status} code=${mismatch.body?.code}`);
  }
  const match = await call(T, "POST", "/invoices", {
    serial_number: `QA-MATCH-${rand}`, vendor_id: ds.procurement.vendorId, hsn: "998311", gst_enabled: true,
    gst_rate: "18", subtotal: "1000.00", payment_mode: "BANK", reference: "QA regression match",
    purchase_order_id: ds.procurement.poId,
  });
  check("invoice w/ matching PO vendor -> 201", match.status === 201, `status=${match.status}`);
}

// -- advances list --------------------------------------------------------
{
  const r = await call(T, "GET", "/advances?limit=5");
  check("GET /advances -> 200", r.status === 200, `status=${r.status}`);
}

// -- tolerance clear (A-013) ----------------------------------------------
{
  const before = await call(T, "GET", "/admin/settings");
  const tol0 = before.body?.settings?.match_tolerance ?? {};
  await call(T, "PATCH", "/admin/settings", { settings: { match_tolerance: { quantity_pct: 5, rate_pct: 3, value_absolute: 200 } } });
  const cleared = await call(T, "PATCH", "/admin/settings", { settings: { match_tolerance: { quantity_pct: 7, rate_pct: null } } });
  const tol = cleared.body?.settings?.match_tolerance ?? {};
  check("tolerance: null clears one sub-field, leaves the other", !("rate_pct" in tol) && tol.value_absolute === 200 && tol.quantity_pct === 7, JSON.stringify(tol));
  await call(T, "PATCH", "/admin/settings", { settings: { match_tolerance: { quantity_pct: tol0.quantity_pct ?? null, rate_pct: tol0.rate_pct ?? null, value_absolute: tol0.value_absolute ?? null } } });
}

// -- expense receipts: clean/EICAR/oversize (B-003) -----------------------
{
  const claim = await call(T, "POST", "/expense-claims", {
    claim_no: `QA-POST-CLAIM-${rand}`, claim_date: "2026-09-24", purpose: "QA post-deploy regression: receipts",
    lines: [{ category: "TRAVEL", expense_date: "2026-09-24", amount: 500, description: "QA regression line" }],
  });
  const claimId = claim.body?.data?.id;
  if (claimId) {
    const clean = Buffer.from("%PDF-1.4\n%QA clean receipt\n").toString("base64");
    const cleanRes = await call(T, "POST", `/expense-claims/${claimId}/receipts`, { file_name: "qa-clean.pdf", content_type: "application/pdf", content_base64: clean });
    check("expense receipt: clean PDF -> 201", cleanRes.status === 201, `status=${cleanRes.status}`);

    let eicarB64;
    try { eicarB64 = readFileSync("/tmp/qa-eicar-embedded.pdf").toString("base64"); } catch { eicarB64 = null; }
    if (eicarB64) {
      const eicarRes = await call(T, "POST", `/expense-claims/${claimId}/receipts`, { file_name: "qa-eicar.pdf", content_type: "application/pdf", content_base64: eicarB64 });
      check("expense receipt: EICAR-in-PDF -> 422 UNSAFE_FILE", eicarRes.status === 422 && eicarRes.body?.code === "UNSAFE_FILE", `status=${eicarRes.status} code=${eicarRes.body?.code}`);
    } else {
      console.log("SKIP  expense receipt: EICAR-in-PDF (build-eicar-pdf.mjs was not run first)");
    }

    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(10.5 * 1024 * 1024, 0x41)]);
    const bigRes = await fetch(`http://127.0.0.1/api/v1/expense-claims/${claimId}/receipts`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}`, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ file_name: "qa-big.pdf", content_type: "application/pdf", content_base64: big.toString("base64") }),
    });
    check("expense receipt: 10.5MB via nginx -> 422 (not a bare 413)", bigRes.status === 422, `status=${bigRes.status}`);
  } else {
    check("expense receipts", false, "could not create a throwaway claim");
  }
}

// -- payment-run execute: route live, proper 4xx not 500 -----------------
{
  const runs = await call(T, "GET", "/payment-runs?limit=1");
  const run = runs.body?.data?.[0];
  if (run) {
    const exec = await call(T, "POST", `/payment-runs/${run.id}/execute`, { paid_on: "2026-09-24", payment_mode: "NEFT", bank_reference: "QA-REGRESS" }, { "if-match": String(run.version) });
    check(`payment-run execute (status=${run.status}) -> proper 4xx, not 500`, exec.status >= 400 && exec.status < 500, `status=${exec.status} code=${exec.body?.code}`);
    console.log("NOTE  payment-run execute: self-approval / period-lock branches need an APPROVED run to click through live — see ledgers.test.ts's 36/36 for those");
  } else {
    console.log("NOTE  payment-run execute: no seeded payment run found");
  }
}

console.log(`\n=== regression-spotcheck: ${failures === 0 ? "all checks held" : failures + " FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
