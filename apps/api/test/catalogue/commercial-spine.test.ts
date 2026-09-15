/**
 * End-to-end cover for the commercial spine: Lead → Opportunity → Tender →
 * Award → Project (§7, §8, §37).
 *
 * These exercise the real HTTP surface against a real database, because the
 * rules under test are enforced by transactions and constraints rather than by
 * application branches — an in-memory double would prove nothing about §37.2
 * idempotency, which is a partial unique index doing the work.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gstinCheckDigit } from "@silverline/shared";
import {
  buildWorld,
  idem,
  uniq,
  type CatalogueWorld,
  type Headers,
} from "./fixture.js";

/**
 * A GSTIN with a correct check digit.
 *
 * An earlier version of this file used a hand-written "29ABCDE1234F1Z5", which
 * the check-digit validator rightly rejects — the fixture was invalid data, not
 * the validator being strict. Deriving it keeps the fixture honest.
 */
let panSeq = 0;
/** A distinct, well-formed PAN per fixture party (GSTINs are unique nationally). */
function uniqPan(): string {
  panSeq += 1;
  return `AAAC${String.fromCharCode(65 + (panSeq % 26))}${String(1000 + panSeq).slice(0, 4)}K`;
}

function gstinFor(stateCode: string, pan = "AAACR5055K", entity = "1"): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

let w: CatalogueWorld;

/** Convenience wrappers that return the full reply rather than just an id. */
async function send(method: "POST" | "PATCH" | "GET", headers: Headers, url: string, payload?: unknown) {
  const res = await w.app.inject({
    method,
    url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}

const post = (h: Headers, url: string, p?: unknown) => send("POST", h, url, p);
const patch = (h: Headers, url: string, p?: unknown) => send("PATCH", h, url, p);
const get = (h: Headers, url: string) => send("GET", h, url);

/** Version header for optimistic concurrency on the new tables. */
async function ifMatchFor(table: string, id: string): Promise<Headers> {
  const r = await w.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  return { "if-match": String(r.rows[0].version) };
}

async function makeClient(over: Record<string, unknown> = {}) {
  const res = await post(w.admin, "/api/v1/clients", {
    code: uniq("CL"), name: `Client ${uniq()}`, client_type: "GOVERNMENT", ...over,
  });
  expect(res.status).toBe(201);
  return res.data;
}

async function makeLeadThroughToQualified(clientId?: string) {
  const lead = (await post(w.admin, "/api/v1/leads", {
    lead_no: uniq("LD"), source: "REFERRAL",
    organization_name: `Org ${uniq()}`, lead_type: "GOVERNMENT",
    estimated_value: "5000000", ...(clientId ? { client_id: clientId } : {}),
  })).data;
  for (const stage of ["CONTACTED", "QUALIFIED"]) {
    const res = await post({ ...w.admin, ...(await ifMatchFor("leads", lead.id)) },
      `/api/v1/leads/${lead.id}/stage`, { stage });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return lead;
}

async function makeAwardedTender(clientId: string, opportunityId?: string) {
  const tender = (await post(w.admin, "/api/v1/tenders", {
    tender_no: uniq("TN"), tender_type: "OPEN", client_id: clientId,
    estimated_value: "5000000", bid_value: "4800000",
    ...(opportunityId ? { opportunity_id: opportunityId } : {}),
  })).data;
  for (const status of ["PUBLISHED", "IN_PROGRESS", "SUBMITTED", "UNDER_EVALUATION", "SELECTED", "AWARDED"]) {
    const res = await post({ ...w.admin, ...(await ifMatchFor("tenders", tender.id)) },
      `/api/v1/tenders/${tender.id}/status`, { status });
    expect(res.status, `${status}: ${JSON.stringify(res.body)}`).toBe(200);
  }
  return tender;
}

async function workspaceId(): Promise<string> {
  const r = await w.pool.query("SELECT id FROM workspaces WHERE org_id = $1 LIMIT 1", [w.orgId]);
  return r.rows[0].id;
}

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

describe("§37 lineage: lead reaches a project with provenance intact", () => {
  it("carries a lead through opportunity, tender and award into a linked project", async () => {
    const client = await makeClient();
    const lead = await makeLeadThroughToQualified(client.id);

    const opp = (await post(w.admin, "/api/v1/opportunities", {
      lead_id: lead.id, expected_value: "5000000",
      expected_close_date: "2026-12-31", probability_pct: 60,
    })).data;
    expect(opp.id).toBeTruthy();

    const tender = await makeAwardedTender(client.id, opp.id);

    // §7.3: creating the tender from the opportunity closes the lead rather
    // than leaving a duplicate open record in the pipeline.
    const closedLead = (await get(w.admin, `/api/v1/leads/${lead.id}`)).data;
    expect(closedLead.stage).toBe("CONVERTED");
    expect(closedLead.status).toBe("CLOSED");

    const project = (await post(w.admin, `/api/v1/tenders/${tender.id}/convert`, {
      workspace_id: await workspaceId(), code: uniq("PRJ"), name: "Awarded work",
      contract_value: "4800000", work_order_number: "WO-1",
    })).data;

    // §8.7: the tender stays permanently linked to the resulting project.
    expect(project.tender_id).toBe(tender.id);
    expect(project.client_id).toBe(client.id);
    expect(project.project_kind).toBe("GOVERNMENT");

    // §37.1: every hop recorded, with the actor and what was carried.
    const lineage = (await get(w.admin, `/api/v1/lineage/project/${project.id}`)).data;
    expect(lineage).toHaveLength(1);
    expect(lineage[0].source_type).toBe("TENDER");
    expect(lineage[0].carried_fields.contract_value).toBe("4800000");
    expect(lineage[0].actor_id).toBe(w.adminId);

    const fromLead = (await get(w.admin, `/api/v1/lineage/lead/${lead.id}`)).data;
    expect(fromLead.map((r: any) => r.target_type)).toContain("OPPORTUNITY");
  });

  it("§8.3 keeps tender status and project status independent", async () => {
    const client = await makeClient();
    const tender = await makeAwardedTender(client.id);
    const project = (await post(w.admin, `/api/v1/tenders/${tender.id}/convert`, {
      workspace_id: await workspaceId(), code: uniq("PRJ"), name: "Independent status",
    })).data;
    // The tender is AWARDED; the project starts at DRAFT and is not dragged along.
    expect(project.status).toBe("DRAFT");
    const detail = (await get(w.admin, `/api/v1/tenders/${tender.id}`)).data;
    expect(detail.status).toBe("AWARDED");
    expect(detail.project.status).toBe("DRAFT");
  });
});

describe("§37.2 conversion is idempotent and transactional", () => {
  it("a retried conversion cannot create a second project", async () => {
    const client = await makeClient();
    const tender = await makeAwardedTender(client.id);
    const body = { workspace_id: await workspaceId(), code: uniq("PRJ"), name: "Only once" };

    const first = await post(w.admin, `/api/v1/tenders/${tender.id}/convert`, body);
    expect(first.status).toBe(201);

    // A fresh idempotency key, so this is a genuine second attempt rather than
    // a replayed response — the database constraint is what must stop it.
    const second = await post(w.admin, `/api/v1/tenders/${tender.id}/convert`,
      { ...body, code: uniq("PRJ") });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("ALREADY_CONVERTED");

    const count = await w.pool.query("SELECT count(*)::int AS n FROM projects WHERE tender_id = $1", [tender.id]);
    expect(count.rows[0].n).toBe(1);
  });

  it("replaying the same request with one idempotency key returns the first result", async () => {
    const client = await makeClient();
    const tender = await makeAwardedTender(client.id);
    const key = idem();
    const payload = { workspace_id: await workspaceId(), code: uniq("PRJ"), name: "Replay" };
    const url = `/api/v1/tenders/${tender.id}/convert`;

    const one = await w.app.inject({ method: "POST", url, headers: { ...w.admin, ...key }, payload });
    const two = await w.app.inject({ method: "POST", url, headers: { ...w.admin, ...key }, payload });
    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(201);
    expect(two.json().data.id).toBe(one.json().data.id);
  });

  it("rolls back entirely when the destination is invalid", async () => {
    const client = await makeClient();
    const tender = await makeAwardedTender(client.id);
    const before = await w.pool.query("SELECT count(*)::int AS n FROM record_conversions");

    // A workspace from another tenant: the project insert must fail and take
    // the lineage row with it rather than leaving a half-converted record.
    const foreign = await w.pool.query(
      "INSERT INTO workspaces(org_id,name,status) VALUES($1,'Foreign','ACTIVE') RETURNING id", [w.otherOrgId]);
    const res = await post(w.admin, `/api/v1/tenders/${tender.id}/convert`, {
      workspace_id: foreign.rows[0].id, code: uniq("PRJ"), name: "Should not commit",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await w.pool.query("SELECT count(*)::int AS n FROM record_conversions");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const orphan = await w.pool.query("SELECT count(*)::int AS n FROM projects WHERE tender_id = $1", [tender.id]);
    expect(orphan.rows[0].n).toBe(0);
  });

  it("refuses to convert a tender that is not awarded", async () => {
    const client = await makeClient();
    const tender = (await post(w.admin, "/api/v1/tenders", {
      tender_no: uniq("TN"), tender_type: "OPEN", client_id: client.id,
    })).data;
    const res = await post(w.admin, `/api/v1/tenders/${tender.id}/convert`, {
      workspace_id: await workspaceId(), code: uniq("PRJ"), name: "Too early",
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("TENDER_NOT_AWARDED");
  });

  it("§37.2 links an existing draft project instead of duplicating it", async () => {
    const client = await makeClient();
    const tender = await makeAwardedTender(client.id);
    const existing = await w.pool.query(
      `INSERT INTO projects(org_id, workspace_id, code, name, status)
       VALUES($1,$2,$3,'Existing draft','DRAFT') RETURNING id`,
      [w.orgId, await workspaceId(), uniq("PRJ")]);

    const res = await post(w.admin, `/api/v1/tenders/${tender.id}/convert`, {
      workspace_id: await workspaceId(), code: uniq("PRJ"), name: "ignored",
      existing_project_id: existing.rows[0].id,
    });
    expect(res.status).toBe(201);
    expect(res.data.id).toBe(existing.rows[0].id);
    const total = await w.pool.query("SELECT count(*)::int AS n FROM projects WHERE tender_id = $1", [tender.id]);
    expect(total.rows[0].n).toBe(1);
  });
});

describe("§7.2 lead stage machine", () => {
  it("refuses a transition the machine does not allow", async () => {
    const lead = (await post(w.admin, "/api/v1/leads", {
      lead_no: uniq("LD"), source: "COLD_OUTREACH",
      organization_name: "Skipper", lead_type: "PRIVATE",
    })).data;
    const res = await post({ ...w.admin, ...(await ifMatchFor("leads", lead.id)) },
      `/api/v1/leads/${lead.id}/stage`, { stage: "TENDER_IDENTIFIED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_STAGE_TRANSITION");
  });

  it("will not mark a lead CONVERTED without a destination record", async () => {
    const lead = await makeLeadThroughToQualified();
    const res = await post({ ...w.admin, ...(await ifMatchFor("leads", lead.id)) },
      `/api/v1/leads/${lead.id}/stage`, { stage: "CONVERTED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_STAGE_TRANSITION");
  });

  it("§7.3 keeps a lost lead and its history rather than deleting it", async () => {
    const lead = await makeLeadThroughToQualified();
    await post(w.admin, "/api/v1/interactions", {
      lead_id: lead.id, interaction_type: "CALL",
      occurred_at: new Date().toISOString(), summary: "Budget pulled",
    });
    const res = await post({ ...w.admin, ...(await ifMatchFor("leads", lead.id)) },
      `/api/v1/leads/${lead.id}/stage`, { stage: "LOST", lost_reason: "Budget withdrawn" });
    expect(res.status).toBe(200);

    const detail = (await get(w.admin, `/api/v1/leads/${lead.id}`)).data;
    expect(detail.stage).toBe("LOST");
    expect(detail.lost_reason).toBe("Budget withdrawn");
    // The timeline survives for §7.5 pipeline analysis.
    expect(detail.timeline.length).toBeGreaterThan(0);
  });

  it("requires a reason when a lead is lost", async () => {
    const lead = await makeLeadThroughToQualified();
    const res = await post({ ...w.admin, ...(await ifMatchFor("leads", lead.id)) },
      `/api/v1/leads/${lead.id}/stage`, { stage: "LOST" });
    expect(res.status).toBe(422);
  });

  it("§7.3 refuses to promote an unqualified lead to an opportunity", async () => {
    const lead = (await post(w.admin, "/api/v1/leads", {
      lead_no: uniq("LD"), source: "OTHER", organization_name: "Raw", lead_type: "PRIVATE",
    })).data;
    const res = await post(w.admin, "/api/v1/opportunities", {
      lead_id: lead.id, expected_value: "100000", expected_close_date: "2026-12-31",
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("LEAD_NOT_QUALIFIED");
  });
});

describe("§8.6/§8.11 eligibility gate", () => {
  async function tenderAtInProgress(clientId: string) {
    const tender = (await post(w.admin, "/api/v1/tenders", {
      tender_no: uniq("TN"), tender_type: "OPEN", client_id: clientId,
    })).data;
    for (const status of ["PUBLISHED", "IN_PROGRESS"]) {
      await post({ ...w.admin, ...(await ifMatchFor("tenders", tender.id)) },
        `/api/v1/tenders/${tender.id}/status`, { status });
    }
    return tender;
  }

  it("blocks SUBMITTED while a required item is outstanding", async () => {
    const client = await makeClient();
    const tender = await tenderAtInProgress(client.id);
    await post(w.admin, `/api/v1/tenders/${tender.id}/eligibility`,
      { requirement_name: "Turnover certificate", is_required: true });

    const res = await post({ ...w.admin, ...(await ifMatchFor("tenders", tender.id)) },
      `/api/v1/tenders/${tender.id}/status`, { status: "SUBMITTED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("ELIGIBILITY_INCOMPLETE");
    // The message names what is missing rather than saying "incomplete".
    expect(res.body.message).toContain("Turnover certificate");
  });

  it("allows SUBMITTED once the required item is ready", async () => {
    const client = await makeClient();
    const tender = await tenderAtInProgress(client.id);
    const item = (await post(w.admin, `/api/v1/tenders/${tender.id}/eligibility`,
      { requirement_name: "ISO certificate", is_required: true })).data;
    await patch(w.admin, `/api/v1/tenders/${tender.id}/eligibility/${item.id}`, { item_status: "READY" });

    const res = await post({ ...w.admin, ...(await ifMatchFor("tenders", tender.id)) },
      `/api/v1/tenders/${tender.id}/status`, { status: "SUBMITTED" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("ignores an outstanding item that is not required", async () => {
    const client = await makeClient();
    const tender = await tenderAtInProgress(client.id);
    await post(w.admin, `/api/v1/tenders/${tender.id}/eligibility`,
      { requirement_name: "Nice to have", is_required: false });
    const res = await post({ ...w.admin, ...(await ifMatchFor("tenders", tender.id)) },
      `/api/v1/tenders/${tender.id}/status`, { status: "SUBMITTED" });
    expect(res.status).toBe(200);
  });

  it("records the override with actor, reason and timestamp on the tender", async () => {
    const client = await makeClient();
    const tender = await tenderAtInProgress(client.id);
    await post(w.admin, `/api/v1/tenders/${tender.id}/eligibility`,
      { requirement_name: "Similar work certificate", is_required: true });

    const res = await post({ ...w.admin, ...(await ifMatchFor("tenders", tender.id)) },
      `/api/v1/tenders/${tender.id}/status`,
      { status: "SUBMITTED", override_reason: "Authority accepted an undertaking in lieu" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await w.pool.query(
      "SELECT eligibility_override_by, eligibility_override_reason, eligibility_override_at FROM tenders WHERE id = $1",
      [tender.id]);
    expect(row.rows[0].eligibility_override_by).toBe(w.adminId);
    expect(row.rows[0].eligibility_override_reason).toContain("undertaking");
    expect(row.rows[0].eligibility_override_at).toBeTruthy();
  });

  it("refuses the override to a role without tender.override", async () => {
    const client = await makeClient();
    const tender = await tenderAtInProgress(client.id);
    await post(w.admin, `/api/v1/tenders/${tender.id}/eligibility`,
      { requirement_name: "Registration class", is_required: true });

    // §4.1/§8.6: the Bid/Tender Manager submits but must not be able to wave
    // away the checklist that gates their own submission.
    const res = await post(
      { ...w.role.BID_TENDER_MANAGER, ...(await ifMatchFor("tenders", tender.id)) },
      `/api/v1/tenders/${tender.id}/status`,
      { status: "SUBMITTED", override_reason: "trust me" });
    expect(res.status).toBe(403);
  });
});

describe("§8.2 tender status machine and §8.5 corrigenda", () => {
  it("refuses a status jump the machine does not allow", async () => {
    const client = await makeClient();
    const tender = (await post(w.admin, "/api/v1/tenders",
      { tender_no: uniq("TN"), tender_type: "OPEN", client_id: client.id })).data;
    const res = await post({ ...w.admin, ...(await ifMatchFor("tenders", tender.id)) },
      `/api/v1/tenders/${tender.id}/status`, { status: "AWARDED" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("§8.5 retains the prior value when a corrigendum shifts a date", async () => {
    const client = await makeClient();
    const tender = (await post(w.admin, "/api/v1/tenders", {
      tender_no: uniq("TN"), tender_type: "OPEN", client_id: client.id,
      start_date: "2026-01-01", closing_date: "2026-02-01",
    })).data;

    const res = await post(w.admin, `/api/v1/tenders/${tender.id}/corrigenda`, {
      corrigendum_no: "C1", date_issued: "2026-01-15",
      summary: "Closing date extended by two weeks",
      changes: { closing_date: "2026-02-15" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // The prior value is kept on the corrigendum, not silently overwritten.
    expect(res.data.prior_values.closing_date).toContain("2026-02-01");

    const updated = (await get(w.admin, `/api/v1/tenders/${tender.id}`)).data;
    expect(String(updated.closing_date)).toContain("2026-02-15");
    expect(updated.corrigenda).toHaveLength(1);
  });

  it("refuses a corrigendum against a field that is not amendable", async () => {
    const client = await makeClient();
    const tender = (await post(w.admin, "/api/v1/tenders",
      { tender_no: uniq("TN"), tender_type: "OPEN", client_id: client.id })).data;
    const res = await post(w.admin, `/api/v1/tenders/${tender.id}/corrigenda`, {
      corrigendum_no: "C9", date_issued: "2026-01-15", summary: "Sneaky",
      changes: { status: "AWARDED" },
    });
    expect(res.status).toBe(422);
  });
});

describe("§6.4 instruments", () => {
  it("rejects an expiry that precedes the issue date", async () => {
    const client = await makeClient();
    const tender = (await post(w.admin, "/api/v1/tenders",
      { tender_no: uniq("TN"), tender_type: "OPEN", client_id: client.id })).data;
    const res = await post(w.admin, "/api/v1/instruments", {
      instrument_type: "EMD", issuing_bank: "SBI", instrument_number: uniq("BG"),
      amount: "100000", issue_date: "2026-03-01", expiry_date: "2026-02-01",
      tender_id: tender.id,
    });
    expect(res.status).toBe(422);
  });

  it("surfaces instruments expiring within a window for §8.4 reminders", async () => {
    const client = await makeClient();
    const tender = (await post(w.admin, "/api/v1/tenders",
      { tender_no: uniq("TN"), tender_type: "OPEN", client_id: client.id })).data;
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const created = await post(w.admin, "/api/v1/instruments", {
      instrument_type: "EMD", issuing_bank: "SBI", instrument_number: uniq("BG"),
      amount: "100000", issue_date: new Date().toISOString().slice(0, 10),
      expiry_date: soon, tender_id: tender.id,
    });
    expect(created.status).toBe(201);
    const listed = (await get(w.admin, "/api/v1/instruments?expiring_within_days=30")).data;
    expect(listed.some((r: any) => r.id === created.data.id)).toBe(true);
  });

  it("will not reopen a released instrument", async () => {
    const client = await makeClient();
    const tender = (await post(w.admin, "/api/v1/tenders",
      { tender_no: uniq("TN"), tender_type: "OPEN", client_id: client.id })).data;
    const inst = (await post(w.admin, "/api/v1/instruments", {
      instrument_type: "EMD", issuing_bank: "SBI", instrument_number: uniq("BG"),
      amount: "100000", issue_date: "2026-01-01", expiry_date: "2026-12-01",
      tender_id: tender.id,
    })).data;
    await post({ ...w.admin, ...(await ifMatchFor("bank_guarantee_instruments", inst.id)) },
      `/api/v1/instruments/${inst.id}/status`, { instrument_status: "RELEASED" });
    const again = await post({ ...w.admin, ...(await ifMatchFor("bank_guarantee_instruments", inst.id)) },
      `/api/v1/instruments/${inst.id}/status`, { instrument_status: "ACTIVE" });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe("INSTRUMENT_CLOSED");
  });
});

describe("§7.1/§51.3 duplicate detection", () => {
  it("rejects a second client sharing a GSTIN", async () => {
    const gstin = gstinFor("29", uniqPan());
    await makeClient({ gstin });
    const second = await post(w.admin, "/api/v1/clients",
      { code: uniq("CL"), name: `Other ${uniq()}`, client_type: "PRIVATE", gstin });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("fails the whole creation when the GSTIN is already taken", async () => {
    // The registration insert is deliberately not ON CONFLICT DO NOTHING:
    // swallowing it would commit a client whose GSTIN went nowhere, which
    // looks like success and loses the tax identifier.
    const gstin = gstinFor("33", uniqPan());
    await makeClient({ gstin });
    const second = await post(w.admin, "/api/v1/clients",
      { code: uniq("CL"), name: `Dup ${uniq()}`, client_type: "PRIVATE", gstin });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("GSTIN_ALREADY_REGISTERED");
  });

  it("refuses to edit a GSTIN through the client record", async () => {
    // A client holds one per state; the column is gone and the registrations
    // endpoint is the only way in.
    const client = await makeClient();
    const res = await patch(w.admin, `/api/v1/clients/${client.id}`, { gstin: gstinFor("27", uniqPan()) });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain("gst-registrations");
  });

  it("warns without blocking when only the name matches", async () => {
    const name = `Shared Name ${uniq()}`;
    await makeClient({ name });
    const second = await post(w.admin, "/api/v1/clients",
      { code: uniq("CL"), name, client_type: "PRIVATE" });
    expect(second.status).toBe(201);
    expect(second.data.duplicate_warnings.length).toBeGreaterThan(0);
  });
});

describe("India statutory identifiers", () => {
  it("refuses a GSTIN that fails its check digit", async () => {
    const good = gstinFor("27");
    const typo = good.slice(0, 14) + (good[14] === "A" ? "B" : "A");
    const res = await post(w.admin, "/api/v1/clients",
      { code: uniq("CL"), name: `Typo ${uniq()}`, client_type: "PRIVATE", gstin: typo });
    expect(res.status).toBe(422);
  });

  it("holds one registration per state for a single party", async () => {
    // The case a single gstin column could not express: one company, three
    // states, three GSTINs, one PAN.
    const pan = uniqPan();
    const client = await makeClient({ pan });
    for (const state of ["27", "29", "36"]) {
      const res = await post(w.admin, `/api/v1/parties/client/${client.id}/gst-registrations`,
        { gstin: gstinFor(state, pan) });
      expect(res.status, `state ${state}: ${JSON.stringify(res.body)}`).toBe(201);
    }
    const listed = (await get(w.admin, `/api/v1/parties/client/${client.id}/gst-registrations`)).data;
    expect(listed).toHaveLength(3);
    expect(new Set(listed.map((r: any) => r.state_code))).toEqual(new Set(["27", "29", "36"]));
  });

  it("refuses a second live registration in the same state", async () => {
    const pan = uniqPan();
    const client = await makeClient({ pan });
    expect((await post(w.admin, `/api/v1/parties/client/${client.id}/gst-registrations`,
      { gstin: gstinFor("27", pan, "1") })).status).toBe(201);
    // A second registration in one state is a data error, not a second office.
    const again = await post(w.admin, `/api/v1/parties/client/${client.id}/gst-registrations`,
      { gstin: gstinFor("27", pan, "2") });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("DUPLICATE_REGISTRATION");
  });

  it("refuses a GSTIN whose embedded PAN contradicts the party", async () => {
    const client = await makeClient({ pan: uniqPan() });
    const res = await post(w.admin, `/api/v1/parties/client/${client.id}/gst-registrations`,
      { gstin: gstinFor("27", uniqPan()) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("GSTIN_PAN_MISMATCH");
  });

  it("names the national collision when a vendor already holds the GSTIN", async () => {
    // uk_clients_pan already stops two client records sharing a PAN, so the
    // cross-party collision is the client-and-vendor case — one firm that both
    // buys from us and supplies to us, which is ordinary in construction.
    const pan = uniqPan();
    const client = await makeClient({ pan });
    const gstin = gstinFor("27", pan);

    const vendor = await w.pool.query(
      `INSERT INTO vendors(org_id, code, name, pan, status) VALUES($1,$2,$3,$4,'ACTIVE') RETURNING id`,
      [w.orgId, uniq("VN"), `Same firm ${uniq()}`, pan]);

    const onVendor = await post(w.admin, `/api/v1/parties/vendor/${vendor.rows[0].id}/gst-registrations`, { gstin });
    expect(onVendor.status, JSON.stringify(onVendor.body)).toBe(201);

    // Same GSTIN on the client record. Reporting "already registered in
    // Maharashtra" would send the operator hunting through client records
    // when the conflicting row is a vendor.
    const clash = await post(w.admin, `/api/v1/parties/client/${client.id}/gst-registrations`, { gstin });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("GSTIN_ALREADY_REGISTERED");
    expect(clash.body.message).toContain("another party");
  });

  it("records a percentage-rate bid against its estimate", async () => {
    const c = await makeClient();
    const res = await post(w.admin, "/api/v1/tenders", {
      tender_no: uniq("TN"), tender_type: "OPEN", client_id: c.id,
      bid_type: "PERCENTAGE_RATE", quoted_percentage: -4.75, ecv: "10000000",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Number(res.data.quoted_percentage)).toBe(-4.75);
  });

  it("refuses an EMD exemption with no registration behind it", async () => {
    const c = await makeClient();
    const res = await post(w.admin, "/api/v1/tenders", {
      tender_no: uniq("TN"), tender_type: "OPEN", client_id: c.id, emd_exempt: true,
    });
    expect(res.status).toBe(422);
  });
});

describe("§4 role boundaries", () => {
  it("lets the Sales/BD Executive run the pipeline", async () => {
    const res = await post(w.role.SALES_BD_EXECUTIVE, "/api/v1/leads", {
      lead_no: uniq("LD"), source: "REFERRAL",
      organization_name: "Sales owned", lead_type: "PRIVATE",
    });
    expect(res.status).toBe(201);
  });

  it("denies the Sales/BD Executive a tender submission", async () => {
    const client = await makeClient();
    const tender = (await post(w.admin, "/api/v1/tenders",
      { tender_no: uniq("TN"), tender_type: "OPEN", client_id: client.id })).data;
    const res = await post(
      { ...w.role.SALES_BD_EXECUTIVE, ...(await ifMatchFor("tenders", tender.id)) },
      `/api/v1/tenders/${tender.id}/status`, { status: "PUBLISHED" });
    expect(res.status).toBe(403);
  });

  it("denies an ordinary employee any sight of the pipeline", async () => {
    expect((await get(w.role.EMPLOYEE, "/api/v1/leads")).status).toBe(403);
    expect((await get(w.role.EMPLOYEE, "/api/v1/tenders")).status).toBe(403);
  });

  it("lets the Auditor read but never write", async () => {
    expect((await get(w.role.AUDITOR, "/api/v1/tenders")).status).toBe(200);
    const res = await post(w.role.AUDITOR, "/api/v1/leads", {
      lead_no: uniq("LD"), source: "OTHER", organization_name: "No", lead_type: "PRIVATE",
    });
    expect(res.status).toBe(403);
  });

  it("§4.1 keeps the Client Viewer out of tender financials entirely", async () => {
    expect((await get(w.role.CLIENT_VIEWER, "/api/v1/tenders")).status).toBe(403);
    expect((await get(w.role.CLIENT_VIEWER, "/api/v1/instruments")).status).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("does not leak another organization's clients", async () => {
    await w.pool.query(
      `INSERT INTO clients(org_id, code, name, client_type) VALUES($1,$2,'Foreign client','PRIVATE')`,
      [w.otherOrgId, uniq("CL")]);
    const mine = (await get(w.admin, "/api/v1/clients?limit=100")).data;
    expect(mine.every((c: any) => c.name !== "Foreign client")).toBe(true);
  });
});

/**
 * Project type and category across the pipeline (§6.2, §7.1, §8.1, §37.2).
 *
 * What the work *is* is known when the lead is first taken, and it decides who
 * bids it and which past jobs are comparable. Capturing it there and carrying
 * it through the conversion stops the same job being filed under a different
 * category at each of its three stages.
 */
describe("UT-CRM-20 pipeline classification", () => {
  async function category(name: string) {
    const res = await post(w.admin, "/api/v1/project-categories", { name });
    expect([200, 201]).toContain(res.status);
    return res.data.id as string;
  }

  it("creates a project type from wherever one is needed", async () => {
    const res = await post(w.admin, "/api/v1/project-types", { name: `Turnkey ${uniq()}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.code).toMatch(/^turnkey_/);
    // A type with no workflow has no statuses its tasks may move between, so
    // the first task raised against it would be stuck immediately.
    const workflow = await w.pool.query(
      "SELECT statuses FROM project_workflows WHERE project_type_id = $1", [res.body.id]);
    expect(workflow.rows[0].statuses).toContain("TO_DO");
  });

  it("returns the existing type rather than a dead end", async () => {
    const name = `Supply Only ${uniq()}`;
    const first = await post(w.admin, "/api/v1/project-types", { name });
    expect(first.status).toBe(201);
    const again = await post(w.admin, "/api/v1/project-types", { name });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it("records the classification on a lead", async () => {
    const cat = await category(`Drones ${uniq()}`);
    const type = await post(w.admin, "/api/v1/project-types", { name: `AMC ${uniq()}` });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const res = await post(w.admin, "/api/v1/leads", {
      lead_no: uniq("LD"), organization_name: `Org ${uniq()}`,
      lead_type: "GOVERNMENT", source: "REFERRAL",
      project_type_id: type.body.id, project_category_id: cat,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.project_category_id).toBe(cat);
    expect(res.data.project_type_id).toBe(type.body.id);
  });

  it("records the classification on a tender, beside the authority's own", async () => {
    // `category` is what the notice printed; project_category_id is ours.
    // They are separate because theirs is evidence and ours is what every
    // report groups by.
    const cat = await category(`CCTV ${uniq()}`);
    const res = await post(w.admin, "/api/v1/tenders", {
      tender_no: uniq("TN"), tender_type: "OPEN",
      category: "Electrical works — sub head 4",
      project_category_id: cat,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.category).toContain("sub head 4");
    expect(res.data.project_category_id).toBe(cat);
  });

  it("refuses a category from another organisation", async () => {
    const foreign = await w.pool.query(
      "INSERT INTO project_categories(org_id, code, name) VALUES($1,$2,$3) RETURNING id",
      [w.other.orgId, uniq("c"), "Foreign"]);
    const res = await post(w.admin, "/api/v1/leads", {
      lead_no: uniq("LD"), organization_name: `Org ${uniq()}`,
      lead_type: "PRIVATE", source: "REFERRAL",
      project_category_id: String(foreign.rows[0].id),
    });
    expect(res.status).toBe(404);
  });

  it("carries the classification from the tender into the project", async () => {
    const cat = await category(`Survey ${uniq()}`);
    const tender = await post(w.admin, "/api/v1/tenders", {
      tender_no: uniq("TN"), tender_type: "OPEN", project_category_id: cat,
    });
    expect(tender.status, JSON.stringify(tender.body)).toBe(201);

    for (const status of ["PUBLISHED", "IN_PROGRESS", "SUBMITTED", "UNDER_EVALUATION", "SELECTED", "AWARDED"]) {
      const current = await w.pool.query("SELECT version FROM tenders WHERE id=$1", [tender.data.id]);
      const moved = await post(
        { ...w.admin, "if-match": String(current.rows[0].version) },
        `/api/v1/tenders/${tender.data.id}/status`, { status });
      expect(moved.status, `${status}: ${JSON.stringify(moved.body)}`).toBe(200);
    }

    const converted = await post(w.admin, `/api/v1/tenders/${tender.data.id}/convert`, {
      workspace_id: w.workspaceId, code: uniq("PC").toUpperCase(), name: "Converted with category",
    });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    // Set once at capture and carried the whole way, rather than re-keyed.
    expect(converted.data.project_category_id).toBe(cat);
  });
});
