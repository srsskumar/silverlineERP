import { test } from "node:test";
import assert from "node:assert/strict";
import { describeApiError, type ApiErrorLike } from "../src/errorFormat";

// Plain object matching the real ApiError's shape (src/api/client.ts) —
// avoided importing that class here so this test stays dependency-free
// (client.ts pulls in expo-crypto, a native module `tsx --test` cannot
// resolve outside the Expo runtime).
function apiError(fields: Partial<ApiErrorLike> & { message: string }): ApiErrorLike {
  return { fieldErrors: [], ...fields };
}

/**
 * M-xxx: every mobile write screen's catch block rendered `e.message` and
 * nothing else. The server's own top-level message for a multi-field zod
 * validation failure is the fixed string "Validation failed" — the actual
 * reason ("to_date: cannot be before from_date") only ever lived in
 * ApiError.fieldErrors, which no screen read. Live-verified on dev-thor:
 * POST /tasks {project_id:"not-a-uuid", title:""} → 422
 * {"code":"VALIDATION_ERROR","message":"Validation failed",
 *  "field_errors":[{"field":"project_id","message":"project_id must be a UUID"},
 *  {"field":"title","message":"Title is required"}]} — a user hitting this on
 * any mobile form saw only "Validation failed", never which field or why.
 */

test("describeApiError prefers field errors over the generic top-level message", () => {
  const e = apiError({
    message: "Validation failed",
    fieldErrors: [
      { field: "project_id", message: "project_id must be a UUID" },
      { field: "title", message: "Title is required" },
    ],
  });
  assert.equal(
    describeApiError(e, "Quick-add failed"),
    "project_id: project_id must be a UUID\ntitle: Title is required",
  );
});

test("describeApiError falls back to the ApiError's own message when there are no field errors", () => {
  const e = apiError({ message: "This request changed while you were looking at it." });
  assert.equal(describeApiError(e, "fallback"), "This request changed while you were looking at it.");
});

test("describeApiError uses a plain Error's message", () => {
  assert.equal(describeApiError(new Error("network down"), "fallback"), "network down");
});

test("describeApiError uses the caller's fallback for a non-Error throw", () => {
  assert.equal(describeApiError("boom", "Could not raise this requisition"), "Could not raise this requisition");
  assert.equal(describeApiError(undefined, "Comment failed"), "Comment failed");
});

test("describeApiError skips a blank field name instead of printing 'undefined: ...'", () => {
  const e = apiError({
    message: "Validation failed",
    fieldErrors: [{ field: "", message: "Idempotency-Key header with a valid UUID is required" }],
  });
  assert.equal(describeApiError(e, "fallback"), "Idempotency-Key header with a valid UUID is required");
});
