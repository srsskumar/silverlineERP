import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * M-xxx: rbac.ts documents an invariant on TAB_PERMISSIONS — "screens that
 * lack permission show a locked-state message instead of data" — but nothing
 * ever imported TAB_PERMISSIONS, and the Attendance tab ran unconditionally:
 * no canDo/canAny check anywhere in the file, unlike Assets and Survey which
 * both gate correctly. Live-verified on dev-thor: CLIENT_VIEWER (permissions
 * ["survey.query","notification.read","dashboard.read","board.read",
 * "project.read","projects.read","survey.read","tasks.read","catalogue.read",
 * "survey.dashboard","task.read","cycle.read","auth.login"] — no attendance.*
 * at all) hitting GET /attendance/me got 404 NO_EMPLOYEE_LINK, silently
 * swallowed by the screen: it still rendered the full punch UI (map, Check
 * in/Check out buttons) with no indication a punch could ever succeed, and
 * fired a GPS permission prompt on mount for a user who could never use it.
 *
 * Structural (no RN renderer under `tsx --test`), same approach as
 * error-containment.test.ts.
 */

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("the Attendance tab gates its content on TAB_PERMISSIONS, like Assets and Survey already do", () => {
  const src = read("app/(tabs)/attendance.tsx");
  assert.match(
    src,
    /TAB_PERMISSIONS/,
    "attendance.tsx must reference TAB_PERMISSIONS.attendance, not run unconditionally",
  );
  assert.match(
    src,
    /canAny\(permissions,\s*TAB_PERMISSIONS\.attendance\)/,
    "must gate on canAny(permissions, TAB_PERMISSIONS.attendance)",
  );
  assert.match(
    src,
    /if\s*\(!canAccess\)\s*\{\s*return\s*\(/,
    "must return a locked-state screen (mirroring assets.tsx's `if (!canDo(...)) return <EmptyState .../>`) instead of rendering the punch UI",
  );
});
