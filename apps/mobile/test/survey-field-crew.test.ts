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
} from "../src/survey/fieldCrew.js";
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

  it("turns the corrected form into an amendment that clears what was removed", () => {
    // PATCH sets only the measures it names, so a measure taken off the form
    // has to be sent as zero or it silently stays.
    const patch = amendmentFor(filed, {
      survey_village_id: VILLAGE, entry_date: TODAY,
      values: { PVT_EXTENT: 25 }, teams_deployed: 2, crew_present: 4,
      govt_staff_present: 0, notes: "rain after 3",
    });
    assert.deepEqual(patch.values, { PVT_EXTENT: 25, VB_POINTS: 0 });
    assert.equal(patch.govt_staff_present, 0);
    assert.match(patch.amendment_reason ?? "", /phone/);
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

  it("clears a note that was removed, rather than keeping the old one", () => {
    const patch = amendmentFor(filed, {
      survey_village_id: VILLAGE, entry_date: TODAY, values: filed.values,
      teams_deployed: 2, govt_staff_present: 1, crew_present: 4,
    });
    assert.equal(patch.notes, null);
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
