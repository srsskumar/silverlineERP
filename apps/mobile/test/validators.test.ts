import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isDateString,
  isUuid,
  validateAttendanceException,
  validateComment,
  validateLeaveRequest,
  validateLogin,
  validateMfaCode,
  validateTaskCreate,
} from "../src/validators.js";
import { can, canAny, PERMISSIONS } from "../src/rbac.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("login validator (mirrors shared loginSchema)", () => {
  it("accepts username+password", () => {
    assert.deepEqual(validateLogin({ username: "ram", password: "x" }), {
      ok: true,
      errors: [],
    });
  });
  it("rejects blanks with field errors", () => {
    const r = validateLogin({ username: " ", password: "" });
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 2);
    assert.deepEqual(
      r.errors.map((e) => e.field).sort(),
      ["password", "username"],
    );
  });
});

describe("mfa validator (mirrors shared mfaVerifySchema)", () => {
  it("accepts exactly 6 digits", () => {
    assert.equal(validateMfaCode("123456").ok, true);
  });
  it("rejects short/long/non-digit codes", () => {
    assert.equal(validateMfaCode("12345").ok, false);
    assert.equal(validateMfaCode("1234567").ok, false);
    assert.equal(validateMfaCode("abcdef").ok, false);
  });
});

describe("task validator (mirrors shared taskCreateSchema)", () => {
  it("title-only quick-add is legal", () => {
    assert.equal(
      validateTaskCreate({ project_id: UUID, title: "Fix pump" }).ok,
      true,
    );
  });
  it("rejects bad project_id and blank/oversize title", () => {
    assert.equal(
      validateTaskCreate({ project_id: "nope", title: "t" }).ok,
      false,
    );
    assert.equal(
      validateTaskCreate({ project_id: UUID, title: "  " }).ok,
      false,
    );
    assert.equal(
      validateTaskCreate({ project_id: UUID, title: "a".repeat(501) }).ok,
      false,
    );
  });
});

describe("comment validator (mirrors taskCommentCreateSchema)", () => {
  it("accepts body incl. @mentions, rejects blank/oversize", () => {
    assert.equal(validateComment("hello @ram").ok, true);
    assert.equal(validateComment("").ok, false);
    assert.equal(validateComment("x".repeat(5001)).ok, false);
  });
});

describe("leave validator (mirrors leaveRequestCreateSchema)", () => {
  it("accepts a well-formed range", () => {
    assert.equal(
      validateLeaveRequest({
        leave_type_id: UUID,
        from_date: "2026-09-10",
        to_date: "2026-09-12",
      }).ok,
      true,
    );
  });
  it("rejects bad uuid, bad dates, inverted range", () => {
    assert.equal(
      validateLeaveRequest({
        leave_type_id: "x",
        from_date: "2026-09-10",
        to_date: "2026-09-12",
      }).ok,
      false,
    );
    assert.equal(
      validateLeaveRequest({
        leave_type_id: UUID,
        from_date: "2026-13-40",
        to_date: "2026-09-12",
      }).ok,
      false,
    );
    const r = validateLeaveRequest({
      leave_type_id: UUID,
      from_date: "2026-09-12",
      to_date: "2026-09-10",
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === "to_date"));
  });
  it("isDateString rejects non-calendar dates", () => {
    assert.equal(isDateString("2026-02-30"), false);
    assert.equal(isDateString("2026-02-28"), true);
    assert.equal(isUuid(UUID), true);
    assert.equal(isUuid("not-a-uuid"), false);
  });
});

describe("attendance exception validator", () => {
  it("requires employee uuid + reason", () => {
    assert.equal(
      validateAttendanceException({
        employee_id: UUID,
        exception_type: "REGULARIZATION",
        reason: "missed punch",
      }).ok,
      true,
    );
    assert.equal(
      validateAttendanceException({
        employee_id: "bad",
        exception_type: "REGULARIZATION",
        reason: "",
      }).ok,
      false,
    );
  });
});

describe("rbac can()", () => {
  it("grants on exact dot-code match", () => {
    assert.equal(can(["task.read"], PERMISSIONS.TASK_READ), true);
    assert.equal(can(["task.read"], PERMISSIONS.TASK_CREATE), false);
  });
  it("list form requires ALL codes", () => {
    assert.equal(
      can(["task.read", "task.transition"], ["task.read", "task.transition"]),
      true,
    );
    assert.equal(can(["task.read"], ["task.read", "task.transition"]), false);
  });
  it("null/undefined grants deny", () => {
    assert.equal(can(null, "task.read"), false);
    assert.equal(can(undefined, "task.read"), false);
  });
  it("canAny gates the approvals inbox", () => {
    assert.equal(canAny(["leave.decide"], ["leave.decide", "leave.admin"]), true);
    assert.equal(canAny(["leave.request"], ["leave.decide", "leave.admin"]), false);
  });
});
