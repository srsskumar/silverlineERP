/**
 * Submitting a village for billing (§066).
 *
 * A resurvey contract does not pay for a village in one go. It releases half
 * the value once ground truthing is signed off, thirty per cent at records
 * preparation, and the last fifth on final submission. Which villages are at
 * which claim is the question the office asks before every review, and it was
 * answered out of a spreadsheet.
 *
 * What is being tested is that the claim is a record of something somebody
 * did — a covering letter that went to the department on a date, under a file
 * number — and not a status the software infers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let programmeId = "";
let villageA = "";
let villageB = "";

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
  return { status: res.statusCode, body, data: body?.data ?? body, meta: body?.meta };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);
const del = (h: Headers, u: string) => send("DELETE", h, u);

async function ver(id: string): Promise<Headers> {
  const r = await w.pool.query("SELECT version FROM survey_village_billing WHERE id = $1", [id]);
  return { "if-match": String(r.rows[0].version) };
}

async function makeVillage(name: string): Promise<string> {
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'ASR') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  const mandal = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'KOYYURU',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);
  const unit = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,$3,$4) RETURNING id`,
    [w.orgId, uniq("V"), name, mandal])).rows[0].id);
  const sv = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
    { village_id: unit, total_extent_ac: 420 });
  expect(sv.status, JSON.stringify(sv.body)).toBe(201);
  const id = String(sv.data.id);

  /*
   * Walked all the way through, because a claim is only due once the stage
   * it falls at has been signed off (§note 17). These tests are about what
   * happens to a claim, not about when one may be raised — that rule has its
   * own suite — so every village here has earned all three.
   */
  // The six stages of the pipeline after §086. NOTIFICATION is what the
  // third claim now waits on, in place of FINAL_DELIVERABLES.
  for (const code of [
    "GROUND_TRUTHING", "GT_QC", "VECTORIZATION", "DATA_SUBMISSION",
    "FINAL_DELIVERABLES", "NOTIFICATION",
  ]) {
    const extra = code === "GROUND_TRUTHING"
      ? { gt_govt_staff_allocated: 2, gt_crew_allocated: 4 } : {};
    const moved = await post(w.admin, `/api/v1/survey/villages/${id}/stage`, {
      stage_code: code, state: "COMPLETED", completed_on: workDate(), ...extra,
    });
    expect(moved.status, `${code}: ${JSON.stringify(moved.body)}`).toBe(200);
  }
  return id;
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Billing programme" });
  programmeId = String(p.data.id);
  villageA = await makeVillage("ADAKULA");
  villageB = await makeVillage("BUTCHAMPETA");
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("recording a claim", () => {
  it("fills in the contract's share so nobody types 50 three hundred times", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 1, reference_no: "RC/2026/114" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.percent).toBe(50);
    expect(r.data.status).toBe("SUBMITTED");
    // Dated today unless somebody says otherwise, because the common case is
    // recording a letter as it goes out.
    expect(r.data.submitted_on).toBeTruthy();
  });

  it("keeps the share that was actually agreed when it differs", async () => {
    // A later contract may split 40/40/20. The rows written under this one
    // must not move when it does, so the percentage is on the claim.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/billing`,
      { milestone: 1, percent: 40 });
    expect(r.status).toBe(201);
    expect(r.data.percent).toBe(40);
  });

  it("refuses a second claim on the same milestone, and says what to do", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 1 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("MILESTONE_ALREADY_CLAIMED");
    expect(r.body.message).toMatch(/already been submitted/i);
    expect(r.body.message).toMatch(/status or reference/i);
  });

  it("will not record a claim as approved without the date it was approved", async () => {
    // A decided claim with no decision date cannot be aged, and ageing them
    // is the reason to track them at all.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 2, status: "APPROVED" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DECISION_DATE_REQUIRED");
  });

  it("refuses a submission dated in the future", async () => {
    const soon = workDate(new Date(Date.now() + 5 * 86400_000));
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 3, submitted_on: soon });
    expect(r.status).toBe(422);
  });

  it("accepts a backdated one, because the letter went out last week", async () => {
    const past = workDate(new Date(Date.now() - 7 * 86400_000));
    // The second, because claims go in order (§080) and the first is already
    // standing on this village. What is being tested is the date, not which
    // milestone carries it.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 2, submitted_on: past, extent_ac: 411.5 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.submitted_on).toBe(past);
    // The extent claimed is what was surveyed, which need not be the extent
    // in the revenue record.
    expect(r.data.extent_ac).toBe(411.5);
  });
});

describe("what has been claimed on a village", () => {
  it("adds up the share released, ignoring what came back", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/billing`);
    expect(r.status).toBe(200);
    // Milestone 1 at 50 and milestone 2 at 30 are standing. The third is not
    // claimable yet on this village: claims go in order (§080) and there is
    // nothing above the second.
    expect(r.meta.claimed_percent).toBe(80);
    expect(r.data.map((c: any) => c.milestone)).toEqual([1, 2]);
  });

  it("stops counting a claim the department returned", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageA}/billing`);
    const second = list.data.find((c: any) => c.milestone === 2);
    const today = workDate();
    const r = await patch({ ...w.admin, ...(await ver(second.id)) },
      `/api/v1/survey/billing/${second.id}`,
      { status: "REJECTED", decided_on: today, remarks: "LPM sheets short" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const after = await get(w.admin, `/api/v1/survey/villages/${villageA}/billing`);
    expect(after.meta.claimed_percent).toBe(50);
  });

  it("will not let a claim be marked paid with no date on it", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageA}/billing`);
    const first = list.data.find((c: any) => c.milestone === 1);
    const r = await patch({ ...w.admin, ...(await ver(first.id)) },
      `/api/v1/survey/billing/${first.id}`, { status: "PAID" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DECISION_DATE_REQUIRED");
  });
});

describe("pulling the list the office needs", () => {
  it("finds every claim in a window", async () => {
    const today = workDate();
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&from=2000-01-01&to=${today}`);
    expect(r.status).toBe(200);
    expect(r.data.length).toBeGreaterThanOrEqual(3);
    // Named, not just identified: the list is read by people.
    expect(r.data[0].village_name).toBeTruthy();
  });

  it("filters to one milestone", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&milestone=1`);
    expect(r.data.every((c: any) => c.milestone === 1)).toBe(true);
    expect(r.data.length).toBe(2);
  });

  it("filters to one status", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&status=REJECTED`);
    expect(r.data.length).toBe(1);
    expect(r.data[0].milestone).toBe(2);
  });

  it("lists villages still owing a milestone", async () => {
    // The question before a review: who is due a second claim. A returned
    // claim leaves the village owing that milestone again.
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&outstanding=2`);
    expect(r.status).toBe(200);
    const ids = r.data.map((v: any) => v.id);
    expect(ids).toContain(villageA);
    expect(ids).toContain(villageB);

    const owed2 = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&outstanding=2`);
    // Village A's second claim was returned, so it is owed again.
    expect(owed2.data.map((v: any) => v.id)).toContain(villageA);
  });

  it("says which milestones a still-owing village has already claimed", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&outstanding=2`);
    const a = r.data.find((v: any) => v.id === villageA);
    expect(a.claimed_milestones).toEqual([1]);
  });

  it("refuses a filter it does not know rather than ignoring it", async () => {
    const r = await get(w.admin, `/api/v1/survey/billing?milestone=1&nonsense=1`);
    expect(r.status).toBe(422);
  });
});

describe("removing a claim", () => {
  it("lets a claim entered by mistake be taken back off the village", async () => {
    const created = await post(w.admin, `/api/v1/survey/villages/${villageB}/billing`,
      { milestone: 2 });
    expect(created.status).toBe(201);
    const r = await del(w.admin, `/api/v1/survey/billing/${created.data.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const after = await get(w.admin, `/api/v1/survey/villages/${villageB}/billing`);
    expect(after.data.map((c: any) => c.milestone)).not.toContain(2);
  });

  it("does not find a claim that was never there", async () => {
    const r = await del(w.admin,
      "/api/v1/survey/billing/00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe(404);
  });
});

describe("claiming a batch of villages at once", () => {
  let batch: string[] = [];

  beforeAll(async () => {
    // Five fresh villages, so the batch tests do not fight the ones above.
    batch = [];
    for (let i = 0; i < 5; i += 1) batch.push(await makeVillage(`BATCH ${i}`));
  }, 120_000);

  const bulk = (body: Record<string, unknown>) =>
    post(w.admin, "/api/v1/survey/billing/bulk", body);

  it("shows what would happen and writes nothing", async () => {
    // This is the screen where somebody finds out they had the wrong filter
    // applied, and by then two hundred villages are claimed.
    const r = await bulk({ survey_village_ids: batch, action: "SUBMIT", milestone: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.dry_run).toBe(true);
    expect(r.data.would_change).toBe(5);

    const check = await get(w.admin, `/api/v1/survey/villages/${batch[0]}/billing`);
    expect(check.data).toEqual([]);
  });

  it("names the villages it would touch, not just a count", async () => {
    const r = await bulk({ survey_village_ids: batch, action: "SUBMIT", milestone: 1 });
    expect(r.data.villages).toContain("BATCH 0");
  });

  it("claims them all once told to", async () => {
    const r = await bulk({
      survey_village_ids: batch, action: "SUBMIT", milestone: 1,
      reference_no: "RC/2026/BATCH", dry_run: false,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.updated).toBe(5);

    const check = await get(w.admin, `/api/v1/survey/villages/${batch[2]}/billing`);
    expect(check.data[0].milestone).toBe(1);
    expect(check.data[0].percent).toBe(50);
    expect(check.data[0].reference_no).toBe("RC/2026/BATCH");
  });

  it("skips what is already claimed and says which, rather than failing the batch", async () => {
    // Refusing all forty because two were already claimed means doing the
    // other thirty-eight again by hand.
    const extra = await makeVillage("BATCH LATE");
    const r = await bulk({
      survey_village_ids: [...batch, extra], action: "SUBMIT", milestone: 1, dry_run: false,
    });
    expect(r.data.updated).toBe(1);
    expect(r.data.skipped).toHaveLength(5);
    expect(r.data.skipped[0].reason).toBe("ALREADY_CLAIMED");
    expect(r.data.skipped.map((s: any) => s.village_name)).toContain("BATCH 0");
  });

  it("claims each village's own extent when asked", async () => {
    const r = await bulk({
      survey_village_ids: batch, action: "SUBMIT", milestone: 2,
      use_village_extent: true, dry_run: false,
    });
    expect(r.data.updated).toBe(5);
    const check = await get(w.admin, `/api/v1/survey/villages/${batch[0]}/billing`);
    const second = check.data.find((c: any) => c.milestone === 2);
    // The village was created with 420 acres.
    expect(second.extent_ac).toBe(420);
  });

  it("warns when a milestone is being claimed with an earlier one outstanding", async () => {
    // Not refused: a variation can release them in any order, and the
    // department decides what it accepts. But the usual cause is the wrong
    // milestone picked, and finding that out before the letter goes is the
    // point of the preview.
    const fresh = await makeVillage("BATCH SKIPPER");
    const r = await bulk({ survey_village_ids: [fresh], action: "SUBMIT", milestone: 3 });
    expect(r.data.would_change).toBe(1);
    expect(r.data.out_of_order).toBe(1);
  });

  it("records the department's answer across the batch", async () => {
    const today = workDate();
    const r = await bulk({
      survey_village_ids: batch, action: "DECIDE", milestone: 1,
      status: "APPROVED", decided_on: today, dry_run: false,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.updated).toBe(5);

    const check = await get(w.admin, `/api/v1/survey/villages/${batch[1]}/billing`);
    const first = check.data.find((c: any) => c.milestone === 1);
    expect(first.status).toBe("APPROVED");
    expect(first.decided_on).toBe(today);
  });

  it("will not record a decision without the date it was decided", async () => {
    const r = await bulk({
      survey_village_ids: batch, action: "DECIDE", milestone: 1, status: "PAID",
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/date the department decided/i);
  });

  it("will not record a decision without saying what was decided", async () => {
    const r = await bulk({
      survey_village_ids: batch, action: "DECIDE", milestone: 1,
      decided_on: workDate(),
    });
    expect(r.status).toBe(422);
  });

  it("says when there is nothing at that milestone to decide", async () => {
    const r = await bulk({
      survey_village_ids: batch, action: "DECIDE", milestone: 7,
      status: "PAID", decided_on: workDate(),
    });
    expect(r.data.would_change).toBe(0);
    expect(r.data.skipped.every((s: any) => s.reason === "NOTHING_TO_DECIDE")).toBe(true);
  });

  it("leaves alone a claim already recorded that way", async () => {
    const today = workDate();
    const r = await bulk({
      survey_village_ids: batch, action: "DECIDE", milestone: 1,
      status: "APPROVED", decided_on: today,
    });
    expect(r.data.would_change).toBe(0);
    expect(r.data.skipped[0].reason).toBe("ALREADY_IN_THAT_STATE");
  });

  it("re-claims a milestone the department returned, under one row", async () => {
    // A returned claim leaves the milestone owed again. A second row would
    // count the percentage twice.
    const today = workDate();
    await bulk({
      survey_village_ids: [batch[3]], action: "DECIDE", milestone: 2,
      status: "REJECTED", decided_on: today, dry_run: false,
    });
    const r = await bulk({
      survey_village_ids: [batch[3]], action: "SUBMIT", milestone: 2, dry_run: false,
    });
    expect(r.data.updated).toBe(1);

    const check = await get(w.admin, `/api/v1/survey/villages/${batch[3]}/billing`);
    expect(check.data.filter((c: any) => c.milestone === 2)).toHaveLength(1);
    expect(check.data.find((c: any) => c.milestone === 2).status).toBe("SUBMITTED");
    // The decision date from the refusal does not survive a fresh claim.
    expect(check.data.find((c: any) => c.milestone === 2).decided_on).toBeNull();
  });

  it("reports ids it could not find rather than pretending it did them", async () => {
    const r = await bulk({
      survey_village_ids: [batch[0], "00000000-0000-0000-0000-000000000000"],
      action: "SUBMIT", milestone: 5,
    });
    expect(r.data.not_found).toEqual(["00000000-0000-0000-0000-000000000000"]);
    expect(r.data.would_change).toBe(1);
  });

  it("refuses an empty batch rather than reporting nothing done", async () => {
    const r = await bulk({ survey_village_ids: [], action: "SUBMIT", milestone: 1 });
    expect(r.status).toBe(422);
  });

  it("refuses more villages than one claim could plausibly cover", async () => {
    const many = Array.from({ length: 1001 },
      () => "00000000-0000-0000-0000-000000000000");
    const r = await bulk({ survey_village_ids: many, action: "SUBMIT", milestone: 1 });
    expect(r.status).toBe(422);
  });
});

describe("claiming out of order", () => {
  it("flags a third claim when the second is still outstanding", async () => {
    // "Has some earlier claim" would wave this through, and a third claim
    // with the second missing is exactly the mistake worth catching.
    const v = await makeVillage("GAPPY");
    await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "SUBMIT", milestone: 1, dry_run: false,
    });
    const r = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "SUBMIT", milestone: 3,
    });
    expect(r.data.out_of_order).toBe(1);
  });

  it("does not flag a claim whose predecessors are all standing", async () => {
    const v = await makeVillage("ORDERLY");
    for (const m of [1, 2]) {
      await post(w.admin, "/api/v1/survey/billing/bulk", {
        survey_village_ids: [v], action: "SUBMIT", milestone: m, dry_run: false,
      });
    }
    const r = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "SUBMIT", milestone: 3,
    });
    expect(r.data.out_of_order).toBe(0);
  });

  it("flags again once a predecessor is returned", async () => {
    // A returned claim leaves that milestone owed, so what follows it is
    // out of order once more.
    const v = await makeVillage("RETURNED");
    for (const m of [1, 2]) {
      await post(w.admin, "/api/v1/survey/billing/bulk", {
        survey_village_ids: [v], action: "SUBMIT", milestone: m, dry_run: false,
      });
    }
    await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "DECIDE", milestone: 2, status: "REJECTED",
      decided_on: workDate(), dry_run: false,
    });
    const r = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "SUBMIT", milestone: 3,
    });
    expect(r.data.out_of_order).toBe(1);
  });

  it("never flags a first claim", async () => {
    const v = await makeVillage("FIRST");
    const r = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "SUBMIT", milestone: 1,
    });
    expect(r.data.out_of_order).toBe(0);
  });
});

describe("a village cannot be claimed past 100%", () => {
  /*
   * Each claim's percent was checked on its own, so claims of seventy and
   * forty were both acceptable and the village was billed at 110%.
   */
  it("refuses a claim that would take the total past a hundred", async () => {
    const v = await makeVillage("OVERCLAIM");
    const first = await post(w.admin, `/api/v1/survey/villages/${v}/billing`,
      { milestone: 1, percent: 70 });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await post(w.admin, `/api/v1/survey/villages/${v}/billing`,
      { milestone: 2, percent: 40 });
    expect(second.status).toBe(422);
    expect(second.body.code).toBe("CLAIMED_OVER_100");
    const fits = await post(w.admin, `/api/v1/survey/villages/${v}/billing`,
      { milestone: 2, percent: 30 });
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
  });

  it("refuses an amendment that would take it past a hundred", async () => {
    const v = await makeVillage("OVERAMEND");
    const m1 = await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 1, percent: 50 });
    await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 2, percent: 40 });
    const r = await patch({ ...w.admin, ...(await ver(m1.data.id)) },
      `/api/v1/survey/billing/${m1.data.id}`, { percent: 70 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("CLAIMED_OVER_100");
    // Its own current figure is not counted twice: 60 + 40 is fine.
    const ok = await patch({ ...w.admin, ...(await ver(m1.data.id)) },
      `/api/v1/survey/billing/${m1.data.id}`, { percent: 60 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("lets only one of two simultaneous claims through when together they exceed it", async () => {
    // Separately each fits; together they would be 110%. Without the lock on
    // the village both read the other's absence and both pass.
    const v = await makeVillage("RACE");
    const m1 = await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 1, percent: 50 });
    const [a, b] = await Promise.all([
      post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 2, percent: 40 }),
      (async () => patch({ ...w.admin, ...(await ver(m1.data.id)) },
        `/api/v1/survey/billing/${m1.data.id}`, { percent: 70 }))(),
    ]);
    expect([a.status, b.status].filter(s => s === 422)).toHaveLength(1);
    const after = await get(w.admin, `/api/v1/survey/villages/${v}/billing`);
    expect(after.meta.claimed_percent).toBeLessThanOrEqual(100);
  });

  it("skips a village in a batch that the claim would take past it, and says why", async () => {
    const v = await makeVillage("OVERBATCH");
    await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 1, percent: 80 });
    const r = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "SUBMIT", milestone: 2, percent: 30,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.would_change).toBe(0);
    expect(r.data.skipped[0].reason).toBe("CLAIMED_OVER_100");
  });
});
