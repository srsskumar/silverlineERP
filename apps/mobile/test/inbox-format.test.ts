/// <reference types="node" />
/**
 * Pure display rules behind the Inbox screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distinctTypes, formatNotificationType, isUnread } from "../src/inboxFormat";

describe("isUnread", () => {
  it("is unread when read_at is absent or null", () => {
    assert.equal(isUnread({}), true);
    assert.equal(isUnread({ read_at: null }), true);
  });

  it("is read once read_at is set", () => {
    assert.equal(isUnread({ read_at: "2026-09-24T00:00:00Z" }), false);
  });
});

describe("formatNotificationType", () => {
  it("title-cases an underscored type code", () => {
    assert.equal(formatNotificationType("TASK_ASSIGNED"), "Task assigned");
    assert.equal(formatNotificationType("LEAVE_APPROVED"), "Leave approved");
  });

  it("falls back to a generic label when the type is missing", () => {
    assert.equal(formatNotificationType(undefined), "Notification");
    assert.equal(formatNotificationType(""), "Notification");
  });
});

describe("distinctTypes", () => {
  it("lists each type once, in first-seen order", () => {
    const items = [{ type: "A" }, { type: "B" }, { type: "A" }, { type: "C" }];
    assert.deepEqual(distinctTypes(items), ["A", "B", "C"]);
  });

  it("skips rows with no type", () => {
    assert.deepEqual(distinctTypes([{}, { type: "A" }]), ["A"]);
  });
});
