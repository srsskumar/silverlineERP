/// <reference types="node" />
/**
 * Pure display/gating rules behind the Reports screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { availableReportTypes, reportCanDownload, reportStatusTone } from "../src/reportsFormat";

const META = [
  { type: "projects", label: "Project progress", permission: "project.read" },
  { type: "tasks", label: "Tasks", permission: "task.read" },
  { type: "payroll", label: "Payroll", permission: "payroll.read" },
];

describe("availableReportTypes", () => {
  it("keeps only the types the permission list allows", () => {
    const rows = availableReportTypes(["report.generate", "project.read", "task.read"], META);
    assert.deepEqual(rows.map((r) => r.type), ["projects", "tasks"]);
  });

  it("returns nothing for a null/undefined permission list", () => {
    assert.deepEqual(availableReportTypes(null, META), []);
    assert.deepEqual(availableReportTypes(undefined, META), []);
  });

  it("returns nothing when no permission matches", () => {
    assert.deepEqual(availableReportTypes(["expense.read"], META), []);
  });
});

describe("reportStatusTone", () => {
  it("colours ready/failed/pending distinctly", () => {
    assert.equal(reportStatusTone("READY"), "success");
    assert.equal(reportStatusTone("FAILED"), "danger");
    assert.equal(reportStatusTone("PENDING"), "warning");
  });

  it("falls back to neutral for anything unrecognised", () => {
    assert.equal(reportStatusTone("WEIRD"), "neutral");
  });
});

describe("reportCanDownload", () => {
  it("allows a ready pdf report", () => {
    assert.equal(reportCanDownload({ status: "READY", format: "pdf" }), true);
  });

  it("refuses a pending report or a non-pdf format", () => {
    assert.equal(reportCanDownload({ status: "PENDING", format: "pdf" }), false);
    assert.equal(reportCanDownload({ status: "READY", format: "csv" }), false);
    assert.equal(reportCanDownload({ status: "READY", format: "xlsx" }), false);
  });
});

describe("availableReportTypes needs report.generate (MA-004)", () => {
  it("offers nothing without report.generate, whatever domain reads are held", () => {
    assert.deepEqual(availableReportTypes(["task.read", "project.read"], META), []);
    assert.deepEqual(
      availableReportTypes(["report.generate", "task.read"], META).map((r) => r.type),
      ["tasks"],
    );
  });
});

describe("REPORT_TYPE_META (MA-004)", () => {
  it("gates the employees report on employee.read, as the API REPORT_DOMAIN_READ does", async () => {
    const { REPORT_TYPE_META } = await import("../src/reportsFormat");
    assert.equal(REPORT_TYPE_META.find((m) => m.type === "employees")?.permission, "employee.read");
  });
});
