/**
 * The work date travels as data, not as display text (SG-014, P0).
 *
 * a2ee8a1 ("one format, one clock") wrapped the survey tab's work date in
 * day() where it was handed to the forms, so the return, the control point
 * and the op key all got "24-Sep-2026" instead of "2026-09-24". The server's
 * own schema, run on the phone, refuses that date, so from 21 Sep no return
 * and no point could be filed from the phone at all.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { day } from "@silverline/shared";
import { buildEntry, emptyDraft } from "../src/survey/returnForm.js";
import { buildPoint, emptyPoint } from "../src/survey/controlPoint.js";

const M = [{ id: "m1", code: "PVT_EXTENT", label: "Private extent", group_label: null,
  unit: "acres", basis: "EXTENT", display_order: 10 }];
const V = "123e4567-e89b-12d3-a456-426614174000";

describe("the survey tab's work date", () => {
  it("is refused by the server's schema in display form, which is why it must not be", () => {
    const r = buildEntry({ villageId: V, entryDate: day("2026-09-20"), measures: M,
      draft: { ...emptyDraft(), quantities: { PVT_EXTENT: "3" } }, lowProgressThresholdAc: null });
    assert.equal(r.ok, false);
    const p = buildPoint({ ...emptyPoint(day("2026-09-20")), pointCode: "G", latitude: "16.512345", longitude: "80.612345" });
    assert.equal(p.ok, false);
  });

  it("is handed to the return, the point and the stage forms as YYYY-MM-DD", () => {
    const src = readFileSync(new URL("../app/(tabs)/survey.tsx", import.meta.url), "utf8");
    assert.equal(/workDate=\{day\(/.test(src), false, "a form is given day(workDate)");
  });

  it("keys the queued return by the ISO date", () => {
    const src = readFileSync(new URL("../src/survey/DailyReturn.tsx", import.meta.url), "utf8");
    assert.equal(/op: `\$\{village\.id\}:\$\{day\(/.test(src), false);
  });
});
