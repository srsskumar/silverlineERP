/**
 * Props that work on iOS and quietly do nothing on Android.
 *
 * React Native does not warn about these. It maps an unrecognised
 * `keyboardType` to "default", so a field that should raise a number pad
 * raises a full QWERTY keyboard instead — on the one platform this app is
 * actually deployed to, in the hands of a crew standing in a village.
 * Development happens on a simulator where it looks right.
 *
 * Android is the target: the field build is an APK (scripts/build-android-preview.mjs),
 * so an iOS-only prop here is not a cosmetic difference, it is the shipped
 * behaviour.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const FILES = [...sources(path.join(mobileRoot, "app")), ...sources(path.join(mobileRoot, "src"))];

/**
 * keyboardType values React Native supports on both platforms. Anything else
 * in the list is iOS-only ("numbers-and-punctuation", "ascii-capable",
 * "name-phone-pad", "twitter", "web-search") or Android-only
 * ("visible-password").
 */
const CROSS_PLATFORM_KEYBOARDS = new Set([
  "default", "number-pad", "decimal-pad", "numeric",
  "email-address", "phone-pad", "url",
]);

describe("Android compatibility", () => {
  it("raises the same keyboard on Android as on iOS", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const body = readFileSync(file, "utf8");
      for (const m of body.matchAll(/keyboardType=["']([a-z-]+)["']/g)) {
        if (!CROSS_PLATFORM_KEYBOARDS.has(m[1])) {
          offenders.push(`${path.relative(mobileRoot, file)}: ${m[1]}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      "these raise a QWERTY keyboard on Android:\n" + offenders.join("\n"));
  });

  it("gives every modal a way out on the Android back button", () => {
    // Android's hardware/gesture back does nothing to a <Modal> without
    // onRequestClose. The user is trapped in a full-screen sheet and force-
    // quits the app, losing anything typed. iOS has a swipe and never shows it.
    const offenders: string[] = [];
    for (const file of FILES) {
      const body = readFileSync(file, "utf8");
      // Each <Modal ...> up to its closing bracket.
      for (const m of body.matchAll(/<Modal\b[\s\S]*?>/g)) {
        if (!m[0].includes("onRequestClose")) {
          offenders.push(path.relative(mobileRoot, file));
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
