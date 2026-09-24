/**
 * The crew's day on the phone, end to end (lane 2 survey gaps,
 * docs/qa/2026-09-24/findings-survey-gaps.md).
 *
 * Each block is a way a day filed from the village was refused by the
 * server after it left the phone. The outbox drops what the server refuses,
 * so each of these was a day of work lost.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  amendmentFor,
  buildStageCompletion,
  completionOffer,
  draftFromEntry,
  isEmptyAmendment,
  isSecondFiling,
  partitionKit,
  pointConfirmations,
  pointSubmission,
  returnSubmission,
  stageSubmission,
} from "../src/survey/fieldCrew.js";
import { day } from "@silverline/shared";
import { buildEntry, emptyDraft } from "../src/survey/returnForm.js";
import { emptyPoint, fromDeviceFix } from "../src/survey/controlPoint.js";

const VILLAGE = "123e4567-e89b-12d3-a456-426614174000";
const TODAY = "2026-09-24";
const MEASURES = [
  { id: "m1", code: "PVT_EXTENT", label: "Private extent", group_label: "Private lands",
    unit: "acres", basis: "EXTENT", display_order: 10 },
  { id: "m2", code: "VB_POINTS", label: "Village boundary points", group_label: "Village boundary",
    unit: "points", basis: "TARGET", display_order: 20 },
];

function kit(over: Record<string, unknown>) {
  return {
    id: "a", asset_id: "x", asset_code: "R-1", asset_name: "Rover", serial_number: null,
    category: "SURVEY", out: true, issued_to_me: true, holder_name: null, ...over,
  };
}

describe("the instruments on the form are the ones this person may file for (SG-001)", () => {
  it("offers only survey instruments issued to the person filing", () => {
    const p = partitionKit([
      kit({ asset_id: "mine", asset_code: "R-1" }),
      kit({ asset_id: "theirs", asset_code: "R-2", issued_to_me: false, holder_name: "Ravi" }),
      kit({ asset_id: "loose", asset_code: "R-3", issued_to_me: false, holder_name: null }),
      kit({ asset_id: "tripod", asset_code: "T-1", category: "ACCESSORY" }),
      kit({ asset_id: "gone", asset_code: "R-4", out: false }),
    ]);
    assert.deepEqual(p.mine.map(r => r.asset_id), ["mine"]);
    assert.deepEqual(p.others.map(r => r.asset_id), ["theirs", "loose"]);
    assert.equal(p.otherKitOut, 1);
  });

  it("says who files for an instrument somebody else carries", () => {
    const p = partitionKit([
      kit({ asset_id: "theirs", asset_code: "R-2", issued_to_me: false, holder_name: "Ravi" }),
      kit({ asset_id: "loose", asset_code: "R-3", issued_to_me: false, holder_name: null }),
    ]);
    assert.match(p.others[0].note, /Ravi/);
    assert.match(p.others[1].note, /not issued to anybody/);
  });

  it("treats a server that does not say as the old behaviour: offered", () => {
    // An older API without issued_to_me must not empty the form.
    const p = partitionKit([kit({ asset_id: "old", issued_to_me: undefined })]);
    assert.deepEqual(p.mine.map(r => r.asset_id), ["old"]);
  });
});

describe("correcting today's return from the phone (SG-003)", () => {
  const filed = {
    id: "e1", version: 3, entry_date: TODAY, teams_deployed: 2, notes: "rain after 3",
    govt_staff_present: 1, crew_present: 4,
    values: { PVT_EXTENT: 12.5, VB_POINTS: 40 },
  };

  it("opens the filed day with its figures, not a blank form", () => {
    const d = draftFromEntry(filed, MEASURES);
    assert.equal(d.quantities.PVT_EXTENT, "12.5");
    assert.equal(d.quantities.VB_POINTS, "40");
    assert.equal(d.teamsDeployed, "2");
    assert.equal(d.govtStaffPresent, "1");
    assert.equal(d.crewPresent, "4");
    assert.equal(d.notes, "rain after 3");
  });

  it("amends only the measures the crew entered; one left blank is not zeroed", () => {
    // Fix round 1: a measure absent from the form was sent as 0, so a replay
    // zeroed figures somebody else had put on the day.
    const patch = amendmentFor(filed, {
      survey_village_id: VILLAGE, entry_date: TODAY,
      values: { PVT_EXTENT: 25 }, govt_staff_present: 0,
    });
    assert.deepEqual(patch.values, { PVT_EXTENT: 25 });
    assert.equal(patch.govt_staff_present, 0);
    assert.match(patch.amendment_reason ?? "", /phone/);
  });

  it("treats blank teams, attendance and notes as not provided, never 0 or cleared", () => {
    const patch = amendmentFor(filed, {
      survey_village_id: VILLAGE, entry_date: TODAY, values: {},
      govt_staff_present: null, crew_present: null,
    });
    assert.deepEqual(patch.values, {});
    for (const k of ["teams_deployed", "govt_staff_present", "crew_present", "notes"]) {
      assert.equal(k in patch, false, k);
    }
  });

  it("removes a figure the crew typed 0 for", () => {
    const patch = amendmentFor(filed, {
      survey_village_id: VILLAGE, entry_date: TODAY, values: { VB_POINTS: 0 },
    });
    assert.deepEqual(patch.values, { VB_POINTS: 0 });
  });

  it("sends nothing it was not asked to change", () => {
    const patch = amendmentFor(filed, {
      survey_village_id: VILLAGE, entry_date: TODAY,
      values: { PVT_EXTENT: 12.5, VB_POINTS: 40 }, teams_deployed: 2,
      govt_staff_present: 1, crew_present: 4, notes: "rain after 3",
    });
    assert.deepEqual(patch.values, {});
    assert.equal("crew_present" in patch, false);
    assert.equal("notes" in patch, false);
  });

  it("knows when there is nothing left to amend, so a retry is a success", () => {
    const same = amendmentFor(filed, {
      survey_village_id: VILLAGE, entry_date: TODAY, values: filed.values,
      teams_deployed: 2, govt_staff_present: 1, crew_present: 4, notes: "rain after 3",
    });
    assert.equal(isEmptyAmendment(same), true);
    assert.equal(isEmptyAmendment({ values: {}, crew_present: 2 }), false);
  });

  it("recognises the refusal that means a day is already in", () => {
    assert.equal(isSecondFiling({ status: 409, code: "ALREADY_ENTERED" }), true);
    assert.equal(isSecondFiling({ status: 409, code: "IDEMPOTENCY_CONFLICT" }), false);
    assert.equal(isSecondFiling({ status: 422, code: "ALREADY_ENTERED" }), false);
    assert.equal(isSecondFiling(null), false);
  });

});

describe("teams deployed is part of the day (SG-008, §59.4.2)", () => {
  it("sends the number of teams out", () => {
    const r = buildEntry({
      villageId: VILLAGE, entryDate: TODAY, measures: MEASURES,
      draft: { ...emptyDraft(), quantities: { PVT_EXTENT: "3" }, teamsDeployed: "2" },
      lowProgressThresholdAc: null,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.entry.teams_deployed, 2);
  });

  it("refuses half a team", () => {
    const r = buildEntry({
      villageId: VILLAGE, entryDate: TODAY, measures: MEASURES,
      draft: { ...emptyDraft(), quantities: { PVT_EXTENT: "3" }, teamsDeployed: "1.5" },
      lowProgressThresholdAc: null,
    });
    assert.equal(r.ok, false);
  });

  it("leaves it out when nobody typed it", () => {
    const r = buildEntry({
      villageId: VILLAGE, entryDate: TODAY, measures: MEASURES,
      draft: { ...emptyDraft(), quantities: { PVT_EXTENT: "3" } },
      lowProgressThresholdAc: null,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal("teams_deployed" in r.entry, false);
  });
});

describe("a control point is looked at twice before it is filed (SG-004)", () => {
  it("asks for a second look at a point that looks swapped", () => {
    const d = { ...emptyPoint(TODAY), pointCode: "GCP-9", latitude: "80.612345", longitude: "16.512345" };
    const c = pointConfirmations(d, null);
    assert.equal(c.length, 1);
    assert.match(c[0], /swapped/);
  });

  it("asks for a second look at (0, 0)", () => {
    const d = { ...emptyPoint(TODAY), pointCode: "GCP-9", latitude: "0", longitude: "0" };
    assert.ok(pointConfirmations(d, null).some(m => /outside India/.test(m)));
  });

  it("asks when the coordinates are still the phone's own fix", () => {
    const fix = { latitude: 16.5123456, longitude: 80.6123456, accuracy: 35 };
    const d = { ...fromDeviceFix({ ...emptyPoint(TODAY), pointCode: "GCP-9" }, fix) };
    const c = pointConfirmations(d, fix);
    assert.ok(c.some(m => /phone/.test(m) && /35 m/.test(m)), c.join(" | "));
  });

  it("stops asking once the controller's figures are typed over the phone's", () => {
    const fix = { latitude: 16.5123456, longitude: 80.6123456, accuracy: 35 };
    const d = { ...fromDeviceFix({ ...emptyPoint(TODAY), pointCode: "GCP-9" }, fix),
      latitude: "16.5124011", longitude: "80.6122987" };
    assert.deepEqual(pointConfirmations(d, fix), []);
  });

  it("has nothing to ask about a good point", () => {
    const d = { ...emptyPoint(TODAY), pointCode: "GCP-9", latitude: "16.512345", longitude: "80.612345" };
    assert.deepEqual(pointConfirmations(d, null), []);
  });
});

describe("marking a stage complete from the village (SG-013)", () => {
  const village = {
    id: VILLAGE, stage_code: "GROUND_TRUTHING", stage_label: "Ground truthing",
    stage_state: "IN_PROGRESS", stage_started_on: "2026-09-10",
    stage_expected_end_on: "2026-10-01", stage_variance_reason: null,
  };

  it("is offered on the stage the person is crewed on, while it is open", () => {
    assert.deepEqual(completionOffer(village, true),
      { stageCode: "GROUND_TRUTHING", label: "Ground truthing" });
  });

  it("is not offered without the right to record", () => {
    assert.equal(completionOffer(village, false), null);
  });

  it("is not offered on a stage that is not running", () => {
    assert.equal(completionOffer({ ...village, stage_state: "NOT_STARTED" }, true), null);
    assert.equal(completionOffer({ ...village, stage_state: "COMPLETED" }, true), null);
    assert.equal(completionOffer({ ...village, stage_state: undefined }, true), null);
  });

  it("does not send the start date it read earlier; the server keeps its own", () => {
    // Fix round 1, item 3. After SG-015 an omitted start is kept, and the
    // one the phone read may be stale by the time the op is sent.
    const r = buildStageCompletion(village, TODAY, null, "");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.body, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: TODAY,
    });
  });

  it("asks why when ground truthing finishes after its date, as the server will", () => {
    const late = { ...village, stage_expected_end_on: "2026-09-20" };
    const r = buildStageCompletion(late, TODAY, null, "");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.problem, /2026-09-20/);
    const ok = buildStageCompletion(late, TODAY, "WEATHER", "");
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.body.variance_reason, "WEATHER");
  });

  it("does not ask again when the reason is already on the stage", () => {
    const late = { ...village, stage_expected_end_on: "2026-09-20", stage_variance_reason: "WEATHER" };
    assert.equal(buildStageCompletion(late, TODAY, null, "").ok, true);
  });

  it("insists on words for a reason of other", () => {
    const late = { ...village, stage_expected_end_on: "2026-09-20" };
    assert.equal(buildStageCompletion(late, TODAY, "OTHER", " ").ok, false);
    assert.equal(buildStageCompletion(late, TODAY, "OTHER", "tahsildar on leave").ok, true);
  });
});

describe("every survey payload carries the ISO work date (SG-014, behavioural)", () => {
  const village = {
    id: VILLAGE, village_name: "V", stage_code: "GROUND_TRUTHING", stage_label: "Ground truthing",
    stage_state: "IN_PROGRESS", stage_started_on: "2026-09-10",
    stage_expected_end_on: "2026-10-01", stage_variance_reason: null,
    low_progress_threshold_ac: null, gt_state: "IN_PROGRESS", gt_expected_end_on: "2026-10-01",
    gt_completed_on: null, gt_variance_reason: null,
  };
  const draft = { ...emptyDraft(), quantities: { PVT_EXTENT: "3" } };

  it("puts it in the return's entry_date and op key", () => {
    const r = returnSubmission({ village, workDate: TODAY, measures: MEASURES, draft, kit: [] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.op.payload.entry_date, TODAY);
    assert.equal(r.op.op, `${VILLAGE}:${TODAY}`);
    assert.equal(r.op.entity, "survey_entry");
  });

  it("puts it in the control point's established_on and the stage's completed_on", () => {
    const p = pointSubmission(VILLAGE, { ...emptyPoint(TODAY), pointCode: "GCP-9",
      latitude: "16.512345", longitude: "80.612345" });
    assert.equal(p.ok, true);
    if (!p.ok) return;
    assert.equal(p.op.payload.established_on, TODAY);
    assert.equal(p.op.payload.survey_village_id, VILLAGE);
    const st = stageSubmission(village, TODAY, null, "");
    assert.equal(st.ok, true);
    if (!st.ok) return;
    assert.equal(st.op.payload.completed_on, TODAY);
  });

  it("refuses a display date anywhere, rather than queueing a day the server rejects", () => {
    const shown = day(TODAY);
    assert.equal(returnSubmission({ village, workDate: shown, measures: MEASURES, draft, kit: [] }).ok, false);
    assert.equal(pointSubmission(VILLAGE, { ...emptyPoint(shown), pointCode: "G",
      latitude: "16.512345", longitude: "80.612345" }).ok, false);
    assert.equal(stageSubmission(village, shown, null, "").ok, false);
  });
});

describe("the return sends only the instruments this person may file for (SG-001 usage)", () => {
  const village = {
    id: VILLAGE, low_progress_threshold_ac: null, gt_state: null, gt_expected_end_on: null,
    gt_completed_on: null, gt_variance_reason: null,
  };
  const MINE = "123e4567-e89b-12d3-a456-4266141740a1";
  const THEIRS = "123e4567-e89b-12d3-a456-4266141740a2";
  const rovers = [
    kit({ asset_id: MINE, asset_code: "R-1" }),
    kit({ asset_id: THEIRS, asset_code: "R-2", issued_to_me: false, holder_name: "Ravi" }),
  ];

  it("drops a rover somebody else carries even if it is on the draft", () => {
    const draft = { ...emptyDraft(), quantities: { PVT_EXTENT: "3" }, rovers: {
      [MINE]: { status: "UTILIZED" as const, idleReason: null, remarks: "" },
      [THEIRS]: { status: "UTILIZED" as const, idleReason: null, remarks: "" },
    } };
    const r = returnSubmission({ village, workDate: TODAY, measures: MEASURES, draft, kit: rovers });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual((r.op.payload.rovers ?? []).map((x: { asset_id: string }) => x.asset_id), [MINE]);
  });

  it("carries the version it was corrected from, and a typed 0 as an entry", () => {
    const filed = { id: "e1", version: 4, entry_date: TODAY, values: { PVT_EXTENT: 3, VB_POINTS: 9 } };
    const draft = { ...emptyDraft(), quantities: { PVT_EXTENT: "3", VB_POINTS: "0" } };
    const r = returnSubmission({ village, workDate: TODAY, measures: MEASURES, draft, kit: [], filed });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.op.baseVersion, 4);
    assert.deepEqual(r.op.payload.values, { PVT_EXTENT: 3, VB_POINTS: 0 });
  });

  it("files a new day with no base version and no zeros", () => {
    const draft = { ...emptyDraft(), quantities: { PVT_EXTENT: "3", VB_POINTS: "0" } };
    const r = returnSubmission({ village, workDate: TODAY, measures: MEASURES, draft, kit: [] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.op.baseVersion, undefined);
    assert.deepEqual(r.op.payload.values, { PVT_EXTENT: 3 });
  });
});
