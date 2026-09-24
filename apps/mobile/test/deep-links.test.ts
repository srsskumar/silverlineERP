import { test } from "node:test";
import assert from "node:assert/strict";
import { isUuid, mobileDeepLink } from "../src/deepLinks";

const TASK_ID = "5f2c9e6a-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const LEAVE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EMP_ID = "11111111-2222-4333-8444-555555555555";

test("isUuid accepts a well-formed UUID and rejects everything else", () => {
  assert.equal(isUuid(TASK_ID), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(123), false);
  // A near-miss (right length, missing a hyphen) must not slip through.
  assert.equal(isUuid("5f2c9e6a1a2b-4c3d-8e9f-0a1b2c3d4e5f"), false);
});

test("mobileDeepLink prefers the server-supplied href over any local fallback", () => {
  assert.equal(
    mobileDeepLink({
      href: `/projects/9c9c9c9c-1111-4222-8333-444444444444/tasks/${TASK_ID}`,
      entity_type: "task",
      entity_id: TASK_ID,
    }),
    `/(tabs)/tasks?taskId=${TASK_ID}`,
  );
});

test("mobileDeepLink maps a leave href to the Leave tab", () => {
  assert.equal(mobileDeepLink({ href: `/leave/${LEAVE_ID}` }), "/(tabs)/leave");
});

test("mobileDeepLink maps the flat web routes to their mobile screens", () => {
  assert.equal(mobileDeepLink({ href: "/reports" }), "/reports");
  assert.equal(mobileDeepLink({ href: "/expenses" }), "/expenses");
  assert.equal(mobileDeepLink({ href: "/procurement" }), "/procurement");
  assert.equal(mobileDeepLink({ href: "/assets" }), "/(tabs)/assets");
});

test("mobileDeepLink maps a ra_bill's /billing href to Project finance (mobile has no separate billing screen)", () => {
  assert.equal(mobileDeepLink({ href: "/billing" }), "/project-finance");
});

test("mobileDeepLink maps a survey_village href (with its web-only query string) to the Survey tab", () => {
  assert.equal(
    mobileDeepLink({ href: "/survey?tab=villages&project=abc&village=def" }),
    "/(tabs)/survey",
  );
});

test("mobileDeepLink maps an employee href to the employee directory", () => {
  assert.equal(mobileDeepLink({ href: `/employees/${EMP_ID}` }), "/employees");
});

test("mobileDeepLink returns null for a web-only destination (admin password reset) so the caller falls back to 'open on web'", () => {
  assert.equal(mobileDeepLink({ href: "/admin?reset=abc" }), null);
});

test("mobileDeepLink returns null (never navigates) when the id inside an href is not a UUID", () => {
  assert.equal(mobileDeepLink({ href: "/leave/not-a-uuid" }), null);
  assert.equal(mobileDeepLink({ href: "/employees/'; DROP TABLE users;--" }), null);
  assert.equal(
    mobileDeepLink({ href: "/projects/abc/tasks/<script>alert(1)</script>" }),
    null,
  );
});

test("mobileDeepLink falls back to the Leave tab for a LEAVE* entity_type when the server sends no href", () => {
  assert.equal(mobileDeepLink({ entity_type: "LEAVE_REQUEST", entity_id: LEAVE_ID }), "/(tabs)/leave");
  assert.equal(mobileDeepLink({ entity_type: "leave", entity_id: LEAVE_ID }), "/(tabs)/leave");
});

test("mobileDeepLink's local fallback still validates the id", () => {
  assert.equal(mobileDeepLink({ entity_type: "LEAVE", entity_id: "garbage" }), null);
});

test("mobileDeepLink returns null for an unknown entity_type with no href", () => {
  assert.equal(mobileDeepLink({ entity_type: "SOME_NEW_TYPE", entity_id: TASK_ID }), null);
  assert.equal(mobileDeepLink({}), null);
});
