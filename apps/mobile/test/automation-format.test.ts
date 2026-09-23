/// <reference types="node" />
/**
 * Pure display rules behind the Automation screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { actionLabel, executionStatusTone, triggerLabel } from "../src/automationFormat";

describe("triggerLabel", () => {
  it("phrases every automationSchema trigger", () => {
    assert.equal(triggerLabel("task.create"), "A task is created");
    assert.equal(triggerLabel("task.status"), "A task's status changes");
    assert.equal(triggerLabel("task.assign"), "A task is assigned");
    assert.equal(triggerLabel("sla.at_risk"), "An SLA is at risk");
    assert.equal(triggerLabel("sla.breached"), "An SLA is breached");
    assert.equal(triggerLabel("task.due"), "A task falls due");
    assert.equal(triggerLabel("cycle.close"), "A cycle closes");
  });

  it("falls back to the raw code for an unrecognised trigger", () => {
    assert.equal(triggerLabel("future.trigger"), "future.trigger");
  });
});

describe("actionLabel", () => {
  it("phrases every automationSchema action type", () => {
    assert.equal(actionLabel({ type: "status", value: "DONE" }), "Set status to DONE");
    assert.equal(actionLabel({ type: "assign", value: "user-1" }), "Assign to user-1");
    assert.equal(actionLabel({ type: "label", value: "urgent" }), "Apply label urgent");
    assert.equal(actionLabel({ type: "comment", value: "Reviewed" }), "Post comment Reviewed");
    assert.equal(actionLabel({ type: "notify", value: "user-2" }), "Notify user-2");
    assert.equal(actionLabel({ type: "webhook", value: "sub-1" }), "Call webhook sub-1");
  });
});

describe("executionStatusTone", () => {
  it("colours SUCCEEDED and FAILED, and anything else neutral", () => {
    assert.equal(executionStatusTone("SUCCEEDED"), "success");
    assert.equal(executionStatusTone("FAILED"), "danger");
    assert.equal(executionStatusTone("PENDING"), "neutral");
  });
});
