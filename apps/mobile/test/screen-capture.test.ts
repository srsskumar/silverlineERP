/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Finding D-5: the payslip and the TOTP enrolment screen must block
// screenshots and recordings while mounted. Hooks cannot run under node:test,
// so this pins the wiring itself: the import and a call at component level.
const screens = ["app/my-payslip.tsx", "app/(auth)/enroll.tsx"];

describe("screen capture protection", () => {
  for (const screen of screens) {
    it(`${screen} prevents screen capture`, () => {
      const source = readFileSync(join(root, screen), "utf8");
      assert.match(source, /import \{ usePreventScreenCapture \} from "expo-screen-capture"/);
      assert.match(source, /^\s*usePreventScreenCapture\("[a-z-]+"\);/m);
    });
  }
});
