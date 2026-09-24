/**
 * A form's "today" is the Indian day, not the UTC one (fix round 1, item 4).
 *
 * expenses.tsx and project-finance.tsx defaulted their date fields with
 * new Date().toISOString().slice(0, 10), which is yesterday until 05:30 IST.
 * A claim entered at 1 a.m. was dated the day before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formToday } from "../src/formDate.js";

describe("formToday", () => {
  it("is the IST calendar day just after midnight, when UTC is still yesterday", () => {
    // 2026-09-24 20:00 UTC is 2026-09-25 01:30 IST.
    assert.equal(formToday(new Date("2026-09-24T20:00:00Z")), "2026-09-25");
  });

  it("agrees with UTC in the middle of the day", () => {
    assert.equal(formToday(new Date("2026-09-24T08:00:00Z")), "2026-09-24");
  });

  it("is written YYYY-MM-DD, as every date field wants", () => {
    assert.match(formToday(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
