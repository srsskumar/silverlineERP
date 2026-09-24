import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { quickAddAssigneeId } from "../src/tasksFormat";

test("quickAddAssigneeId self-assigns when the caller cannot assign elsewhere", () => {
  assert.equal(quickAddAssigneeId(false, "user-1"), "user-1");
});

test("quickAddAssigneeId leaves the task unassigned when the caller holds task.assign", () => {
  assert.equal(quickAddAssigneeId(true, "user-1"), undefined);
});

test("quickAddAssigneeId leaves the task unassigned when there is no signed-in user id yet", () => {
  assert.equal(quickAddAssigneeId(false, null), undefined);
  assert.equal(quickAddAssigneeId(false, undefined), undefined);
});

describe("taskDueDate (MA-005)", () => {
  it("reads planned_end_date, since the list row has no due_date field", async () => {
    const { taskDueDate } = await import("../src/tasksFormat");
    assert.equal(taskDueDate({ planned_end_date: "2026-10-01" }), "2026-10-01");
    assert.equal(taskDueDate({ planned_end_date: null }), null);
    assert.equal(taskDueDate({}), null);
  });
});

describe("deepLinkTaskId (MA-006)", () => {
  it("accepts a UUID, flags anything else, and ignores an absent param", async () => {
    const { deepLinkTaskId } = await import("../src/tasksFormat");
    const id = "0d53f8f0-44b7-491e-b6b1-e678b2e48516";
    assert.deepEqual(deepLinkTaskId(id), { id, invalid: false });
    assert.deepEqual(deepLinkTaskId("nope"), { id: null, invalid: true });
    assert.deepEqual(deepLinkTaskId(undefined), { id: null, invalid: false });
    assert.deepEqual(deepLinkTaskId(["x"]), { id: null, invalid: false });
  });
});
