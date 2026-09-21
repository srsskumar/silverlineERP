/**
 * End-to-end cover for document governance (§46).
 *
 * The register spans entities, derives its state from dates at read time, and
 * enforces retention against a seeded type list — none of which can be checked
 * without real rows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;

async function send(
  method: "POST" | "GET" | "PATCH" | "DELETE", headers: Headers, url: string, payload?: unknown,
) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);
const del = (h: Headers, u: string) => send("DELETE", h, u);

async function ver(id: string): Promise<Headers> {
  const r = await w.pool.query("SELECT version FROM documents WHERE id = $1", [id]);
  return { "if-match": String(r.rows[0].version) };
}

/** A date `days` from today, as YYYY-MM-DD. */
function dayOffset(days: number): string {
  const d = new Date(`${workDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** An organisation-level document, which needs no owner id. */
async function orgDoc(over: Record<string, unknown> = {}) {
  const r = await post(w.admin, "/api/v1/documents", {
    type_code: "LABOUR_LICENCE",
    owner_type: "organization",
    title: `Licence ${uniq()}`,
    expires_on: dayOffset(200),
    ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.data;
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("§46 seeded types", () => {
  it("gives the organisation a governed type list on migration", async () => {
    // Without a seeded list the first user types "Labour Licence", the second
    // types "labour license", and the register stops being answerable.
    const r = await get(w.admin, "/api/v1/document-types");
    expect(r.status).toBe(200);
    expect(r.data.length).toBeGreaterThan(20);
    const codes = r.data.map((t: any) => t.code);
    expect(codes).toContain("LABOUR_LICENCE");
    expect(codes).toContain("WC_POLICY");
    expect(codes).toContain("LIFTING_TACKLE_CERTIFICATE");
  });

  it("carries the statutory basis through to the reader", async () => {
    // Somebody told their site cannot operate deserves to be told why.
    const r = await get(w.admin, "/api/v1/document-types");
    const licence = r.data.find((t: any) => t.code === "LABOUR_LICENCE");
    expect(licence.basis).toContain("Contract Labour");
    expect(licence.blocks_operations).toBe(true);
  });
});

describe("§46.2 the register", () => {
  it("records an organisation-level document without an owner id", async () => {
    const doc = await orgDoc();
    expect(doc.owner_type).toBe("organization");
    expect(doc.owner_id).toBeNull();
  });

  it("refuses a document attached to an owner its type does not allow", async () => {
    // A vehicle fitness certificate has no business on an employee record.
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "FITNESS_CERTIFICATE",
      owner_type: "employee",
      owner_id: w.directEmployee,
      title: "Fitness on a person",
      expires_on: dayOffset(90),
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("OWNER_NOT_ALLOWED");
  });

  it("refuses a type it has never heard of", async () => {
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "INVENTED_TYPE",
      owner_type: "organization",
      title: "Nonsense",
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("UNKNOWN_TYPE");
  });

  it("refuses a labour licence with no expiry date", async () => {
    // Worse than no record: it reads as compliant forever.
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "LABOUR_LICENCE",
      owner_type: "organization",
      title: "Undated licence",
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("EXPIRY_REQUIRED");
  });

  it("refuses a non-organisation document with no owner id", async () => {
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "DRAWING",
      owner_type: "project",
      title: "Orphan drawing",
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("OWNER_REQUIRED");
  });

  it("refuses an expiry before the document takes effect", async () => {
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "LABOUR_LICENCE",
      owner_type: "organization",
      title: "Backwards",
      valid_from: dayOffset(100),
      expires_on: dayOffset(10),
    });
    expect(r.status).toBe(422);
  });
});

describe("§46.3 expiry", () => {
  it("derives valid, expiring and expired from the dates", async () => {
    // The labour licence type gives sixty days of notice.
    const valid = await orgDoc({ expires_on: dayOffset(200) });
    const expiring = await orgDoc({ expires_on: dayOffset(30) });
    const expired = await orgDoc({ expires_on: dayOffset(-10) });

    const r = await get(w.admin, "/api/v1/documents?limit=200");
    const byId = new Map(r.data.map((d: any) => [d.id, d]));
    expect((byId.get(valid.id) as any).state).toBe("VALID");
    expect((byId.get(expiring.id) as any).state).toBe("EXPIRING");
    expect((byId.get(expired.id) as any).state).toBe("EXPIRED");
  });

  it("honours the notice window of the type rather than a global one", async () => {
    // A PUC is renewed in an afternoon and gets seven days of warning; a
    // labour licence takes six weeks and gets sixty. Forty days out, one is
    // valid and the other is already expiring.
    const puc = await post(w.admin, "/api/v1/documents", {
      type_code: "PUC", owner_type: "asset", owner_id: w.assetId,
      title: "PUC", expires_on: dayOffset(40),
    });
    const licence = await orgDoc({ expires_on: dayOffset(40) });

    const r = await get(w.admin, "/api/v1/documents?limit=200");
    const byId = new Map(r.data.map((d: any) => [d.id, d]));
    expect((byId.get(puc.data.id) as any).state).toBe("VALID");
    expect((byId.get(licence.id) as any).state).toBe("EXPIRING");
  });

  it("is still in force on the day it expires", async () => {
    // A licence valid "until 31 March" is valid on 31 March. Treating the
    // expiry date as already lapsed stops work a day early.
    const doc = await orgDoc({ expires_on: workDate() });
    const r = await get(w.admin, `/api/v1/documents/${doc.id}`);
    expect(r.data.state).toBe("EXPIRING");
    expect(r.data.days_remaining).toBe(0);
  });

  it("counts what stops work apart from what is merely untidy", async () => {
    const r = await get(w.admin, "/api/v1/documents?limit=200");
    expect(r.body.summary).toHaveProperty("blocking");
    expect(r.body.summary).toHaveProperty("blockingSoon");
    // Every licence created above blocks operations.
    expect(r.body.summary.blocking).toBeGreaterThan(0);
  });
});

describe("§46.3 the renewal queue", () => {
  it("puts what has already lapsed ahead of what has not", async () => {
    const r = await get(w.admin, "/api/v1/documents/renewals?within_days=365");
    expect(r.status).toBe(200);
    const days = r.data.map((d: any) => d.days_remaining);
    // Sorted ascending, so anything negative comes first.
    expect([...days].sort((a: number, b: number) => a - b)).toEqual(days);
  });

  it("respects the window asked for", async () => {
    await orgDoc({ expires_on: dayOffset(300) });
    const near = await get(w.admin, "/api/v1/documents/renewals?within_days=30");
    const far = await get(w.admin, "/api/v1/documents/renewals?within_days=365");
    expect(far.data.length).toBeGreaterThan(near.data.length);
  });

  it("leaves out anything that does not expire", async () => {
    await post(w.admin, "/api/v1/documents", {
      type_code: "WORK_ORDER", owner_type: "project", owner_id: w.activeProject,
      title: "Work order with no expiry",
    });
    const r = await get(w.admin, "/api/v1/documents/renewals?within_days=365");
    expect(r.data.every((d: any) => d.expires_on !== null)).toBe(true);
  });
});

describe("§46.4 revisions", () => {
  it("renews by superseding rather than by editing the date", async () => {
    // The previous certificate existed and an inspector may ask for it.
    const old = await orgDoc({ expires_on: dayOffset(20), reference_number: "LL/2025/001" });

    const renewed = await post(
      w.admin, `/api/v1/documents/${old.id}/renew`,
      { expires_on: dayOffset(400), reference_number: "LL/2026/001" },
    );
    expect(renewed.status).toBe(201);
    expect(renewed.data.supersedes_id).toBe(old.id);

    // The old row is still there, still readable, and no longer chased.
    const before = await get(w.admin, `/api/v1/documents/${old.id}`);
    expect(before.status).toBe(200);
    expect(before.data.state).toBe("SUPERSEDED");
    expect(before.data.expires_on).toBe(dayOffset(20));
  });

  it("carries forward what the renewal did not restate", async () => {
    const old = await orgDoc({
      expires_on: dayOffset(20),
      issuing_authority: "Labour Commissioner, Telangana",
    });
    const renewed = await post(
      w.admin, `/api/v1/documents/${old.id}/renew`, { expires_on: dayOffset(400) });
    expect(renewed.data.issuing_authority).toBe("Labour Commissioner, Telangana");
    expect(renewed.data.owner_type).toBe(old.owner_type);
    expect(renewed.data.type_id).toBe(old.type_id);
  });

  it("needs no version header, because the old row is never modified", async () => {
    // A renewal inserts a successor. The row lock serialises two concurrent
    // renewals and the unique index refuses the second, so demanding a
    // version here would be friction that guards nothing.
    const old = await orgDoc({ expires_on: dayOffset(20) });
    const r = await post(w.admin, `/api/v1/documents/${old.id}/renew`,
      { expires_on: dayOffset(400) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("refuses to renew the same document twice", async () => {
    // Two rows both claiming to be the current revision is the exact failure
    // the register exists to prevent.
    const old = await orgDoc({ expires_on: dayOffset(20) });
    await post(w.admin, `/api/v1/documents/${old.id}/renew`, { expires_on: dayOffset(400) });
    const again = await post(
      w.admin, `/api/v1/documents/${old.id}/renew`, { expires_on: dayOffset(500) });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_RENEWED");
  });

  it("drops a superseded document out of the renewal queue", async () => {
    const old = await orgDoc({ expires_on: dayOffset(5) });
    await post(w.admin, `/api/v1/documents/${old.id}/renew`, { expires_on: dayOffset(400) });
    const r = await get(w.admin, "/api/v1/documents/renewals?within_days=365");
    expect(r.data.some((d: any) => d.id === old.id)).toBe(false);
  });

  it("shows the revision it replaced on the detail view", async () => {
    const old = await orgDoc({ expires_on: dayOffset(20) });
    const renewed = await post(
      w.admin, `/api/v1/documents/${old.id}/renew`, { expires_on: dayOffset(400) });
    const r = await get(w.admin, `/api/v1/documents/${renewed.data.id}`);
    expect(r.data.supersedes.id).toBe(old.id);
  });
});

describe("§46.6 retention and legal hold", () => {
  it("refuses deletion while retention is still running, and says until when", async () => {
    // The next question after "no" is always "when".
    const doc = await orgDoc({ expires_on: dayOffset(-10) });
    const r = await del({ ...w.admin, ...(await ver(doc.id)) }, `/api/v1/documents/${doc.id}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("RETENTION_BLOCKED");
    expect(r.body.message).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("allows deletion once retention has run", async () => {
    // A labour licence is kept three years after it expires.
    const doc = await orgDoc({ expires_on: dayOffset(-365 * 4) });
    const r = await del({ ...w.admin, ...(await ver(doc.id)) }, `/api/v1/documents/${doc.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const gone = await get(w.admin, `/api/v1/documents/${doc.id}`);
    expect(gone.status).toBe(404);
  });

  it("refuses deletion under legal hold whatever the document's age", async () => {
    const doc = await orgDoc({ expires_on: dayOffset(-365 * 20) });
    const held = await post(
      { ...w.admin, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}/legal-hold`,
      { legal_hold: true, reason: "Arbitration with the client" },
    );
    expect(held.status).toBe(200);

    const r = await del({ ...w.admin, ...(await ver(doc.id)) }, `/api/v1/documents/${doc.id}`);
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("legal hold");
  });

  it("deletes once the hold is released", async () => {
    const doc = await orgDoc({ expires_on: dayOffset(-365 * 20) });
    await post(
      { ...w.admin, ...(await ver(doc.id)) }, `/api/v1/documents/${doc.id}/legal-hold`,
      { legal_hold: true, reason: "Under audit" });
    await post(
      { ...w.admin, ...(await ver(doc.id)) }, `/api/v1/documents/${doc.id}/legal-hold`,
      { legal_hold: false });
    const r = await del({ ...w.admin, ...(await ver(doc.id)) }, `/api/v1/documents/${doc.id}`);
    expect(r.status).toBe(200);
  });

  it("refuses a hold with no reason", async () => {
    // An unexplained hold is indistinguishable from an oversight three weeks on.
    const doc = await orgDoc();
    const r = await post(
      { ...w.admin, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}/legal-hold`, { legal_hold: true });
    expect(r.status).toBe(422);
  });

  it("refuses to delete a revision a later one still refers to", async () => {
    // Deleting it would leave the successor claiming to replace nothing.
    const old = await orgDoc({ expires_on: dayOffset(-365 * 20) });
    await post(w.admin, `/api/v1/documents/${old.id}/renew`, { expires_on: dayOffset(400) });
    const r = await del({ ...w.admin, ...(await ver(old.id)) }, `/api/v1/documents/${old.id}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("HAS_SUCCESSOR");
  });
});

describe("§46.6.3 confidentiality", () => {
  it("withholds the detail of a confidential document but still lists it", async () => {
    // Hiding the row outright would leave a lapsed medical certificate
    // silently missing from the renewal queue.
    const doc = await post(w.admin, "/api/v1/documents", {
      type_code: "MEDICAL_FITNESS",
      owner_type: "employee",
      owner_id: w.directEmployee,
      title: "Medical fitness",
      reference_number: "MED/2026/0041",
      expires_on: dayOffset(20),
    });
    expect(doc.status).toBe(201);

    // The project manager can read the register but not confidential detail.
    const pm = await get(w.role.PROJECT_MANAGER, "/api/v1/documents?limit=200");
    const seen = pm.data.find((d: any) => d.id === doc.data.id);
    expect(seen, "the document should still be listed").toBeTruthy();
    expect(seen.restricted).toBe(true);
    expect(seen.reference_number).toBeNull();
    // Its expiry is not secret: somebody has to chase the renewal.
    expect(seen.expires_on).toBe(dayOffset(20));

    const hr = await get(w.role.HR_MANAGER, "/api/v1/documents?limit=200");
    const full = hr.data.find((d: any) => d.id === doc.data.id);
    expect(full.restricted).toBe(false);
    expect(full.reference_number).toBe("MED/2026/0041");
  });
});

describe("§46 access control", () => {
  it("refuses the register to a role with no document permission", async () => {
    const r = await get(w.role.EMPLOYEE, "/api/v1/documents");
    expect(r.status).toBe(403);
  });

  it("lets an auditor place a hold but not delete", async () => {
    // An auditor who can destroy evidence is not a control.
    const doc = await orgDoc({ expires_on: dayOffset(-365 * 20) });
    const hold = await post(
      { ...w.role.AUDITOR, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}/legal-hold`,
      { legal_hold: true, reason: "Statutory audit" });
    expect(hold.status).toBe(200);

    const r = await del(
      { ...w.role.AUDITOR, ...(await ver(doc.id)) }, `/api/v1/documents/${doc.id}`);
    expect(r.status).toBe(403);
  });

  it("keeps one tenant's documents out of another's register", async () => {
    const doc = await orgDoc();
    const other = (await w.pool.query(
      "SELECT count(*)::int AS n FROM documents WHERE org_id = $1 AND id = $2",
      [w.otherOrgId, doc.id])).rows[0];
    expect(other.n).toBe(0);
  });
});

describe("§46 concurrency", () => {
  it("refuses a write against a stale version", async () => {
    const doc = await orgDoc();
    const stale = { ...w.admin, "if-match": "1" };
    await patch({ ...w.admin, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}`, { title: "First edit" });
    const second = await patch(stale, `/api/v1/documents/${doc.id}`, { title: "Second edit" });
    expect(second.status).toBe(409);
  });
});

describe("§46.6.1 dates are fixed once recorded", () => {
  it("refuses to move an expiry date back far enough to pass retention", async () => {
    // A licence still inside retention, backdated twenty years, became
    // deletable on the spot: the edit defeated the rule it was checked by.
    const doc = await orgDoc({ expires_on: dayOffset(-10) });
    const r = await patch({ ...w.admin, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}`, { expires_on: dayOffset(-365 * 20) });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DATES_IMMUTABLE");

    const still = await del({ ...w.admin, ...(await ver(doc.id)) }, `/api/v1/documents/${doc.id}`);
    expect(still.status).toBe(409);
    expect(still.body.code).toBe("RETENTION_BLOCKED");
  });

  it("refuses to clear the expiry of a type that requires one", async () => {
    // A labour licence with no expiry reads as compliant forever.
    const doc = await orgDoc({ expires_on: dayOffset(20) });
    const r = await patch({ ...w.admin, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}`, { expires_on: null });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DATES_IMMUTABLE");
    const after = await get(w.admin, `/api/v1/documents/${doc.id}`);
    expect(after.data.expires_on).toBe(dayOffset(20));
  });

  it("refuses to change the issue date", async () => {
    const doc = await orgDoc({ issued_on: dayOffset(-30) });
    const r = await patch({ ...w.admin, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}`, { issued_on: dayOffset(-4000) });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DATES_IMMUTABLE");
  });

  it("still saves a form that sends the dates back unchanged", async () => {
    const doc = await orgDoc({ expires_on: dayOffset(90), issued_on: dayOffset(-5) });
    const r = await patch({ ...w.admin, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}`,
      { title: "Renamed licence", expires_on: dayOffset(90), issued_on: dayOffset(-5) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.title).toBe("Renamed licence");
  });

  it("refuses to amend a revision that has been superseded", async () => {
    // The old row is the record of what was in force. Editing it rewrites
    // the history a renewal is there to keep.
    const old = await orgDoc({ expires_on: dayOffset(20) });
    await post(w.admin, `/api/v1/documents/${old.id}/renew`, { expires_on: dayOffset(400) });
    const r = await patch({ ...w.admin, ...(await ver(old.id)) },
      `/api/v1/documents/${old.id}`, { title: "Rewritten" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("SUPERSEDED");
  });
});

describe("§46.4 revising what never expires", () => {
  it("revises a drawing without an expiry date", async () => {
    // A drawing does not expire, and demanding a date for its revision made
    // the only honest answer impossible to record.
    const drawing = await post(w.admin, "/api/v1/documents", {
      type_code: "DRAWING", owner_type: "project", owner_id: w.activeProject,
      title: "GA drawing", revision: "R0",
    });
    expect(drawing.status, JSON.stringify(drawing.body)).toBe(201);
    const r = await post(w.admin, `/api/v1/documents/${drawing.data.id}/renew`, { revision: "R1" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.revision).toBe("R1");
    expect(r.data.expires_on).toBeNull();
    expect(r.data.supersedes_id).toBe(drawing.data.id);
  });

  it("still requires an expiry to renew a type that must have one", async () => {
    const old = await orgDoc({ expires_on: dayOffset(20) });
    const r = await post(w.admin, `/api/v1/documents/${old.id}/renew`, { reference_number: "LL/2" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("EXPIRY_REQUIRED");
  });
});

describe("§46.6.2 releasing a hold is its own permission", () => {
  it("refuses a release to a role that may place a hold but not lift one", async () => {
    // Take the release away from the auditor for this test only; the suite
    // runs in one fork, so no other file sees the change.
    const roleId = (await w.pool.query("SELECT id FROM roles WHERE code = 'AUDITOR'")).rows[0].id;
    await w.pool.query(
      "DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'document.legalhold.release'",
      [roleId]);
    try {
      const doc = await orgDoc({ expires_on: dayOffset(-365 * 20) });
      const held = await post({ ...w.role.AUDITOR, ...(await ver(doc.id)) },
        `/api/v1/documents/${doc.id}/legal-hold`, { legal_hold: true, reason: "Statutory audit" });
      expect(held.status).toBe(200);

      const released = await post({ ...w.role.AUDITOR, ...(await ver(doc.id)) },
        `/api/v1/documents/${doc.id}/legal-hold`, { legal_hold: false });
      expect(released.status).toBe(403);
      expect(released.body.message).toContain("document.legalhold.release");
      const after = await get(w.admin, `/api/v1/documents/${doc.id}`);
      expect(after.data.legal_hold).toBe(true);
    } finally {
      await w.pool.query(
        `INSERT INTO role_permissions (role_id, permission_code)
         VALUES ($1, 'document.legalhold.release') ON CONFLICT DO NOTHING`, [roleId]);
    }
  });

  it("lets a role with the release permission lift the hold", async () => {
    const doc = await orgDoc({ expires_on: dayOffset(-365 * 20) });
    await post({ ...w.role.AUDITOR, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}/legal-hold`, { legal_hold: true, reason: "Statutory audit" });
    const released = await post({ ...w.role.AUDITOR, ...(await ver(doc.id)) },
      `/api/v1/documents/${doc.id}/legal-hold`, { legal_hold: false });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.data.legal_hold).toBe(false);
  });
});

describe("§46.2 the owner must exist", () => {
  it("refuses an owner id that is nothing at all", async () => {
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "DRAWING", owner_type: "project",
      owner_id: "00000000-0000-4000-8000-000000000000", title: "Drawing for nobody",
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("OWNER_NOT_FOUND");
  });

  it("refuses another organisation's employee", async () => {
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "MEDICAL_FITNESS", owner_type: "employee", owner_id: w.other.employee,
      title: "Somebody else's certificate", expires_on: dayOffset(90),
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("OWNER_NOT_FOUND");
  });

  it("refuses an id of the wrong kind of owner", async () => {
    // An employee's id filed as a project owner exists, but not as a project.
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "DRAWING", owner_type: "project", owner_id: w.directEmployee,
      title: "Drawing on a person",
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("OWNER_NOT_FOUND");
  });

  it("accepts an owner that exists in this organisation", async () => {
    const r = await post(w.admin, "/api/v1/documents", {
      type_code: "DRAWING", owner_type: "project", owner_id: w.activeProject, title: "Real drawing",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});
