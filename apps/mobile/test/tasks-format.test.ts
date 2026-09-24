import { test } from "node:test";
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
