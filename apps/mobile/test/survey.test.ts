import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEntry,
  emptyDraft,
  extentToday,
  parseNumber,
  type ReturnDraft,
} from "../src/survey/returnForm.js";
import {
  buildPoint,
  emptyPoint,
  fromDeviceFix,
  parseDecimal,
} from "../src/survey/controlPoint.js";
import { DELAY_REASON_CODES } from "@silverline/shared";
import { PERMISSIONS, TAB_PERMISSIONS, can } from "../src/rbac.js";

const VILLAGE = "123e4567-e89b-12d3-a456-426614174000";
const ROVER_A = "223e4567-e89b-12d3-a456-426614174001";
const ROVER_B = "323e4567-e89b-12d3-a456-426614174002";
const TODAY = "2026-09-19";

const MEASURES = [
  { id: "m1", code: "PVT_EXTENT", label: "Private extent", group_label: "Private lands",
    unit: "acres", basis: "EXTENT", display_order: 10 },
  { id: "m2", code: "VB_POINTS", label: "Village boundary points", group_label: "Village boundary",
    unit: "points", basis: "TARGET", display_order: 20 },
];

function draft(patch: Partial<ReturnDraft> = {}): ReturnDraft {
  return { ...emptyDraft(), ...patch };
}

describe("parseNumber", () => {
  it("reads a blank as null, not as zero", () => {
    // The distinction the attendance fields are built on: null is "nobody was
    // asked", zero is "nobody came".
    assert.deepEqual(parseNumber("", "Crew present"), { value: null });
    assert.deepEqual(parseNumber("   ", "Crew present"), { value: null });
    assert.deepEqual(parseNumber("0", "Crew present"), { value: 0 });
  });

  it("refuses what Number() would silently accept", () => {
    for (const junk of ["12abc", "1e5", "--3", "1.2.3", "٣", "12 34"]) {
      const r = parseNumber(junk, "Extent");
      assert.equal(r.value, null, `${junk} should not parse`);
      assert.match(r.error ?? "", /must be a number/);
    }
  });

  it("refuses a fractional headcount", () => {
    const r = parseNumber("2.5", "Crew present", { integer: true });
    assert.match(r.error ?? "", /whole number/);
  });

  it("refuses a negative quantity outright", () => {
    assert.match(parseNumber("-4", "Extent").error ?? "", /must be a number/);
  });
});

describe("extentToday", () => {
  it("sums the extent measures and ignores the counts", () => {
    const q = { PVT_EXTENT: "12.5", VB_POINTS: "400" };
    assert.equal(extentToday(q, MEASURES), 12.5);
  });
  it("treats an unparseable figure as nothing rather than crashing", () => {
    assert.equal(extentToday({ PVT_EXTENT: "abc" }, MEASURES), 0);
  });
});

describe("buildEntry", () => {
  const base = {
    villageId: VILLAGE,
    entryDate: TODAY,
    measures: MEASURES,
    lowProgressThresholdAc: null as number | null,
  };

  it("builds the entry the server takes", () => {
    const r = buildEntry({
      ...base,
      draft: draft({
        quantities: { PVT_EXTENT: "12.5", VB_POINTS: "400" },
        rovers: { [ROVER_A]: { status: "UTILIZED", idleReason: null, remarks: "" } },
        govtStaffPresent: "0",
        crewPresent: "4",
      }),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.entry.values, { PVT_EXTENT: 12.5, VB_POINTS: 400 });
    assert.equal(r.entry.survey_village_id, VILLAGE);
    assert.equal(r.entry.entry_date, TODAY);
    // Zero present is sent as 0, not dropped: nobody came is the finding.
    assert.equal(r.entry.govt_staff_present, 0);
    assert.equal(r.entry.crew_present, 4);
    assert.deepEqual(r.entry.rovers, [
      { asset_id: ROVER_A, status: "UTILIZED", idle_reason: null, remarks: null },
    ]);
  });

  it("never sends a typed zero as a quantity", () => {
    // A measure absent and a measure at zero mean the same thing, and two
    // spellings of one fact is how the two come to disagree.
    const r = buildEntry({
      ...base,
      draft: draft({
        quantities: { PVT_EXTENT: "0", VB_POINTS: "400" },
      }),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(Object.keys(r.entry.values), ["VB_POINTS"]);
  });

  it("refuses an idle rover with no reason, and names every problem at once", () => {
    const r = buildEntry({
      ...base,
      draft: draft({
        quantities: { PVT_EXTENT: "3" },
        rovers: {
          [ROVER_A]: { status: "IDLE", idleReason: null, remarks: "" },
          [ROVER_B]: { status: "IDLE", idleReason: null, remarks: "" },
        },
      }),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    // Both, not the first: a crew member at dusk should be told everything.
    assert.equal(r.problems.length, 2);
  });

  it('refuses an "other" idle reason with no remarks', () => {
    const r = buildEntry({
      ...base,
      draft: draft({
        quantities: { PVT_EXTENT: "3" },
        rovers: { [ROVER_A]: { status: "IDLE", idleReason: "OTHER", remarks: "  " } },
      }),
    });
    assert.equal(r.ok, false);
  });

  it("accepts every idle reason the server knows, and no others", () => {
    for (const code of DELAY_REASON_CODES) {
      const r = buildEntry({
        ...base,
        draft: draft({
          quantities: { PVT_EXTENT: "3" },
          rovers: { [ROVER_A]: { status: "IDLE", idleReason: code, remarks: "because" } },
        }),
      });
      assert.equal(r.ok, true, `${code} should be accepted`);
    }
    const bogus = buildEntry({
      ...base,
      draft: draft({
        quantities: { PVT_EXTENT: "3" },
        rovers: { [ROVER_A]: { status: "IDLE", idleReason: "ROVER_FAULT", remarks: "x" } },
      }),
    });
    assert.equal(bogus.ok, false);
  });

  it("asks for a low-progress reason on the device, before the queue swallows the question", () => {
    // The whole reason the threshold is sent to the phone: the server would
    // refuse this, but hours later, with nobody left to ask.
    const short = buildEntry({
      ...base,
      lowProgressThresholdAc: 10,
      draft: draft({
        quantities: { PVT_EXTENT: "2" },
        rovers: { [ROVER_A]: { status: "UTILIZED", idleReason: null, remarks: "" } },
      }),
    });
    assert.equal(short.ok, false);
    if (short.ok) return;
    assert.match(short.problems.join(" "), /below the 10 acre threshold/);

    const withReason = buildEntry({
      ...base,
      lowProgressThresholdAc: 10,
      draft: draft({
        quantities: { PVT_EXTENT: "2" },
        rovers: { [ROVER_A]: { status: "UTILIZED", idleReason: null, remarks: "" } },
        lowProgressReason: "WEATHER",
      }),
    });
    assert.equal(withReason.ok, true);
  });

  it("asks nothing when the programme sets no threshold", () => {
    const r = buildEntry({
      ...base,
      lowProgressThresholdAc: null,
      draft: draft({
        quantities: { PVT_EXTENT: "0.5" },
        rovers: { [ROVER_A]: { status: "UTILIZED", idleReason: null, remarks: "" } },
      }),
    });
    assert.equal(r.ok, true);
  });

  it("refuses a return that records nothing at all", () => {
    const r = buildEntry({ ...base, draft: draft() });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.problems.join(" "), /Nothing is recorded/);
  });

  it("warns, without refusing, when quantities are filed with nobody present", () => {
    const r = buildEntry({ ...base, draft: draft({ quantities: { PVT_EXTENT: "12" } }) });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.warnings.length, 1);
  });
});

describe("control point", () => {
  it("takes a signed decimal, unlike the daily return's quantities", () => {
    assert.equal(parseDecimal("-37.5", "Latitude").value, -37.5);
    assert.equal(parseDecimal("16.512345", "Latitude").value, 16.512345);
    assert.match(parseDecimal("16,51", "Latitude").error ?? "", /must be a number/);
  });

  it("records a point with coordinates alone", () => {
    const r = buildPoint({ ...emptyPoint(TODAY), pointCode: "GCP-1",
      latitude: "16.512345", longitude: "80.612345" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.input.point_code, "GCP-1");
    assert.equal(r.warnings.length, 0);
  });

  it("insists on a name", () => {
    const r = buildPoint({ ...emptyPoint(TODAY), pointCode: "  ",
      latitude: "16.5", longitude: "80.6" });
    assert.equal(r.ok, false);
  });

  it("insists on both coordinates", () => {
    const r = buildPoint({ ...emptyPoint(TODAY), pointCode: "GCP-1", latitude: "16.5" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.problems.join(" "), /needs a longitude/);
  });

  it("refuses half a grid reference, and a grid with no zone", () => {
    const half = buildPoint({ ...emptyPoint(TODAY), pointCode: "GCP-1",
      latitude: "16.512345", longitude: "80.612345", eastingM: "451234", gridZone: "44N" });
    assert.equal(half.ok, false);

    const noZone = buildPoint({ ...emptyPoint(TODAY), pointCode: "GCP-1",
      latitude: "16.512345", longitude: "80.612345",
      eastingM: "451234", northingM: "1825600" });
    assert.equal(noZone.ok, false);
    if (noZone.ok) return;
    assert.match(noZone.problems.join(" "), /Name the grid/);

    const whole = buildPoint({ ...emptyPoint(TODAY), pointCode: "GCP-1",
      latitude: "16.512345", longitude: "80.612345",
      eastingM: "451234", northingM: "1825600", gridZone: "44N" });
    assert.equal(whole.ok, true);
  });

  it("records swapped coordinates but says they look swapped", () => {
    // Never a refusal: the warning is advisory, and the point is still the
    // only record of where somebody stood.
    const r = buildPoint({ ...emptyPoint(TODAY), pointCode: "GCP-1",
      latitude: "80.612345", longitude: "16.512345" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.warnings.join(" "), /swapped/);
  });

  it("flags a fix entered to whole degrees", () => {
    const r = buildPoint({ ...emptyPoint(TODAY), pointCode: "GCP-1",
      latitude: "16", longitude: "80" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.warnings.join(" "), /110 km/);
  });

  it("fills from the device fix at full precision and keeps it overwritable", () => {
    const filled = fromDeviceFix(emptyPoint(TODAY),
      { latitude: 16.5123456789, longitude: 80.6123456789, accuracy: 8 });
    assert.equal(filled.latitude, "16.512346");
    assert.equal(filled.longitude, "80.612346");
    // No altitude from the OS leaves the field alone rather than writing a 0.
    assert.equal(filled.elevationM, "");
  });
});

describe("survey tab gating", () => {
  it("gates the tab on read and the forms on entry", () => {
    assert.deepEqual(TAB_PERMISSIONS.survey, [PERMISSIONS.SURVEY_READ]);
    // A client viewer on a crew list: sees the work, cannot record against it.
    assert.equal(can(["survey.read"], PERMISSIONS.SURVEY_READ), true);
    assert.equal(can(["survey.read"], PERMISSIONS.SURVEY_ENTER), false);
    assert.equal(can(["survey.read", "survey.enter"], PERMISSIONS.SURVEY_ENTER), true);
  });
});

describe("ground truthing past its date, on the phone", () => {
  const base = {
    villageId: VILLAGE,
    entryDate: TODAY,
    measures: MEASURES,
    lowProgressThresholdAc: null as number | null,
    today: TODAY,
  };

  it("asks for the reason the server will demand, before the outbox takes it", () => {
    /*
     * The failure this prevents: the route refuses a day on an overdue
     * village, the return is already queued, and the queue discards what the
     * server rejects. The day's work is gone and nobody is asked anything.
     */
    const r = buildEntry({
      ...base,
      draft: draft({ quantities: { PVT_EXTENT: "12" } }),
      groundTruthing: { state: "IN_PROGRESS", expectedEndOn: "2026-08-01" },
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.problems.join(" "), /due on 2026-08-01/);
  });

  it("takes the reason and sends it with the day", () => {
    const r = buildEntry({
      ...base,
      draft: draft({
        quantities: { PVT_EXTENT: "12" },
        gtVarianceReason: "NO_DEPT_STAFF",
      }),
      groundTruthing: { state: "IN_PROGRESS", expectedEndOn: "2026-08-01" },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.entry.gt_variance_reason, "NO_DEPT_STAFF");
  });

  it("stops asking once the reason is on the stage", () => {
    const r = buildEntry({
      ...base,
      draft: draft({ quantities: { PVT_EXTENT: "12" } }),
      groundTruthing: {
        state: "IN_PROGRESS", expectedEndOn: "2026-08-01", varianceReason: "WEATHER",
      },
    });
    assert.equal(r.ok, true);
  });

  it("never asks a village that is inside its window, or has no date", () => {
    for (const gt of [
      { state: "IN_PROGRESS", expectedEndOn: "2026-12-01" },
      { state: "IN_PROGRESS", expectedEndOn: null },
      null,
    ]) {
      const r = buildEntry({
        ...base, draft: draft({ quantities: { PVT_EXTENT: "12" } }), groundTruthing: gt,
      });
      assert.equal(r.ok, true, JSON.stringify(gt));
    }
  });

  it('insists on the sentence when the reason is "other"', () => {
    const r = buildEntry({
      ...base,
      draft: draft({ quantities: { PVT_EXTENT: "12" }, gtVarianceReason: "OTHER" }),
      groundTruthing: { state: "IN_PROGRESS", expectedEndOn: "2026-08-01" },
    });
    assert.equal(r.ok, false);
  });
});
