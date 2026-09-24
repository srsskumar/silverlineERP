/// <reference types="node" />
/**
 * MA-001/MA-002: the Assets tab's pure helpers (src/assetsFormat.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNABLE_CONDITIONS,
  eligibleEmployeeLabel,
  filterEligibleEmployees,
  validateAssetCondition,
} from "../src/assetsFormat";

// Exactly what GET /api/v1/assets/eligible-employees sends (live-checked):
// no `name` field at all.
const LIVE = [
  { id: "a", emp_no: "EMP-001", first_name: "Anil", last_name: "Varma" },
  { id: "b", emp_no: "EMP-002", first_name: "Amit", last_name: null },
  { id: "c", emp_no: "EMP-003", first_name: null, last_name: null },
];

describe("eligibleEmployeeLabel (MA-001)", () => {
  it("builds the label from first/last name and emp no, since the row has no name field", () => {
    assert.equal(eligibleEmployeeLabel(LIVE[0]!), "Anil Varma · EMP-001");
    assert.equal(eligibleEmployeeLabel(LIVE[1]!), "Amit · EMP-002");
    assert.equal(eligibleEmployeeLabel(LIVE[2]!), "EMP-003");
  });
});

describe("filterEligibleEmployees (MA-001)", () => {
  it("does not throw on the live row shape and matches name or emp no", () => {
    assert.deepEqual(filterEligibleEmployees(LIVE, "").map((e) => e.id), ["a", "b", "c"]);
    assert.deepEqual(filterEligibleEmployees(LIVE, "amit").map((e) => e.id), ["b"]);
    assert.deepEqual(filterEligibleEmployees(LIVE, "emp-003").map((e) => e.id), ["c"]);
  });
  it("caps the list at ten", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      emp_no: `E${i}`,
      first_name: "X",
      last_name: null,
    }));
    assert.equal(filterEligibleEmployees(many, "").length, 10);
  });
});

describe("asset condition vocabulary (MA-002)", () => {
  it("offers the shared codes a receiver picks from, minus OTHER (which needs a note)", () => {
    assert.deepEqual(
      ASSIGNABLE_CONDITIONS.map((c) => c.code),
      ["BRAND_NEW", "EXCELLENT", "GOOD", "REPAIR", "UNUSABLE"],
    );
    assert.equal(ASSIGNABLE_CONDITIONS.find((c) => c.code === "REPAIR")?.label, "Needs repair");
  });
  it("refuses free text the register would otherwise store verbatim", () => {
    assert.equal(validateAssetCondition("GOOD"), null);
    assert.match(String(validateAssetCondition("good")), /condition/i);
    assert.match(String(validateAssetCondition("")), /condition/i);
    assert.match(String(validateAssetCondition("OTHER")), /condition/i);
  });
});
