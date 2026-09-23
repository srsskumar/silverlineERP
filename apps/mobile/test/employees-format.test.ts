/// <reference types="node" />
/**
 * Pure display helpers behind the Employee directory screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { employeeStatusTone, formatEmployeeName } from "../src/employeesFormat";

describe("formatEmployeeName", () => {
  it("joins first and last name", () => {
    assert.equal(formatEmployeeName({ first_name: "Asha", last_name: "Rao" }), "Asha Rao");
  });

  it("drops a missing or blank last name instead of leaving a trailing space", () => {
    assert.equal(formatEmployeeName({ first_name: "Asha", last_name: null }), "Asha");
    assert.equal(formatEmployeeName({ first_name: "Asha", last_name: "" }), "Asha");
    assert.equal(formatEmployeeName({ first_name: "Asha" }), "Asha");
  });
});

describe("employeeStatusTone", () => {
  it("colours each status EMPLOYEE_STATUSES can produce", () => {
    assert.equal(employeeStatusTone("ACTIVE"), "success");
    assert.equal(employeeStatusTone("SUSPENDED"), "warning");
    assert.equal(employeeStatusTone("EXITED"), "danger");
    assert.equal(employeeStatusTone("DRAFT"), "neutral");
  });
});
