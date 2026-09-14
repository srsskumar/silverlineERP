import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression cover for the crash-loop that sent users back to Home.
 *
 * The app had exactly one error boundary and it wrapped AuthProvider. Any
 * render error therefore unmounted the provider, destroying the React state
 * holding the session; the remount called loadSession(), which returns null by
 * design so a fresh launch demands credentials. Net effect: one component
 * error signed the user out and reset navigation to the first tab — which is
 * what "it goes to home whenever I open any page" actually was.
 *
 * The crash reports never arrived either: reportClientError enqueues to the
 * outbox, and the outbox only flushes while signed in, so the logout suppressed
 * the evidence of the thing that caused the logout.
 *
 * These assertions are structural because the suite runs under `tsx --test` on
 * .ts files only — there is no renderer here to mount a component tree in.
 */

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("the route boundary is nested inside AuthProvider, not wrapped around it", () => {
  const layout = read("app/_layout.tsx");
  const provider = layout.indexOf("<AuthProvider>");
  const routeBoundary = layout.indexOf("<RouteErrorBoundary>");
  const stack = layout.indexOf("<Stack");

  assert.ok(provider > -1, "AuthProvider should still mount in the root layout");
  assert.ok(routeBoundary > -1, "a RouteErrorBoundary should wrap the navigator");
  assert.ok(
    provider < routeBoundary,
    "the boundary must open AFTER AuthProvider — wrapping the provider means a screen error unmounts it and drops the session",
  );
  assert.ok(routeBoundary < stack, "the boundary should contain the navigator");
});

test("every tab screen contains its own render errors", () => {
  const dir = "app/(tabs)";
  const screens = readdirSync(join(root, dir)).filter(
    (f) => f.endsWith(".tsx") && f !== "_layout.tsx",
  );
  assert.ok(screens.length >= 6, `expected the tab screens, found ${screens.length}`);
  for (const file of screens) {
    const src = read(join(dir, file));
    assert.match(
      src,
      /export default withScreenBoundary\(/,
      `${file} must export through withScreenBoundary so its errors do not unmount the navigator`,
    );
  }
});

test("a boundary clears itself when the route changes", () => {
  // Without this a boundary latches `failed` forever: the first broken screen
  // poisons every screen the user visits afterwards.
  const src = read("src/ui/ErrorBoundary.tsx");
  assert.match(src, /getDerivedStateFromProps/);
  assert.match(src, /resetKey/);
  assert.match(src, /usePathname/);
});

test("unmatched routes land on +not-found instead of silently falling back", () => {
  const src = read("app/+not-found.tsx");
  assert.match(src, /export default function/);
});

test("crash reporting still cannot throw a second error", () => {
  // reportClientError runs from componentDidCatch; if it threw, the boundary
  // would fail while handling a failure.
  const src = read("src/device/diagnostics.ts");
  assert.match(src, /catch\s*\{/, "reportClientError must swallow its own errors");
});
