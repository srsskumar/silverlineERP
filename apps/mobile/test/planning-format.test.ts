/// <reference types="node" />
/**
 * Pure display/grouping rules behind the Planning screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cycleMetricsSummary, cycleStatusTone, groupCycles } from "../src/planningFormat";

describe("cycleStatusTone", () => {
  it("colours planned/active/closed distinctly", () => {
    assert.equal(cycleStatusTone("PLANNED"), "neutral");
    assert.equal(cycleStatusTone("ACTIVE"), "info");
    assert.equal(cycleStatusTone("CLOSED"), "success");
  });

  it("falls back to neutral for anything unrecognised", () => {
    assert.equal(cycleStatusTone("WEIRD"), "neutral");
  });
});

describe("groupCycles", () => {
  const cycles = [
    { id: "c1", status: "CLOSED", start_date: "2026-01-01", end_date: "2026-01-14" },
    { id: "c2", status: "ACTIVE", start_date: "2026-09-15", end_date: "2026-09-28" },
    { id: "c3", status: "PLANNED", start_date: "2026-10-13", end_date: "2026-10-26" },
    { id: "c4", status: "CLOSED", start_date: "2026-02-01", end_date: "2026-02-14" },
    { id: "c5", status: "PLANNED", start_date: "2026-09-29", end_date: "2026-10-12" },
  ];

  it("buckets by status", () => {
    const grouped = groupCycles(cycles);
    assert.deepEqual(grouped.active.map((c) => c.id), ["c2"]);
    assert.deepEqual(grouped.planned.map((c) => c.id), ["c5", "c3"]);
    assert.deepEqual(grouped.closed.map((c) => c.id), ["c4", "c1"]);
  });

  it("sorts planned soonest-first and closed most-recent-first", () => {
    const grouped = groupCycles(cycles);
    assert.equal(grouped.planned[0].start_date, "2026-09-29");
    assert.equal(grouped.closed[0].end_date, "2026-02-14");
  });

  it("handles no cycles", () => {
    const grouped = groupCycles([]);
    assert.deepEqual(grouped, { active: [], planned: [], closed: [] });
  });
});

describe("cycleMetricsSummary", () => {
  it("summarises a closed cycle's metrics", () => {
    assert.equal(
      cycleMetricsSummary({ planned: 12, completed: 7, remaining: 5 }),
      "12 planned · 7 done · 5 remaining",
    );
  });

  it("returns null before a cycle has metrics", () => {
    assert.equal(cycleMetricsSummary(null), null);
    assert.equal(cycleMetricsSummary(undefined), null);
    assert.equal(cycleMetricsSummary({}), null);
  });
});
