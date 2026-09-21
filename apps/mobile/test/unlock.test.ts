/**
 * MOB-4: the background lock asks the device for its own credential.
 *
 * It used to answer "unlocked" for anyone who had not switched biometric
 * unlock on, which was most people, so the lock never asked them anything.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECURITY_LEVEL_NONE, unlockWith, type UnlockDeps } from "../src/device/unlock";

const SECRET = 1; // PIN, pattern or passcode, no biometric
const BIOMETRIC_STRONG = 3;

function deviceWith(level: number | Error, opts: { enabled?: boolean; passes?: boolean } = {}) {
  const prompts: Array<{ promptMessage: string; disableDeviceFallback: boolean }> = [];
  const deps: UnlockDeps = {
    getEnrolledLevelAsync: async () => {
      if (level instanceof Error) throw level;
      return level;
    },
    authenticateAsync: async (options) => {
      prompts.push(options);
      return { success: opts.passes ?? true };
    },
    biometricEnabled: async () => opts.enabled ?? false,
  };
  return { deps, prompts };
}

describe("MOB-4 background lock", () => {
  it("prompts a user who never turned biometric unlock on", async () => {
    const d = deviceWith(BIOMETRIC_STRONG, { enabled: false, passes: false });
    assert.equal(await unlockWith(d.deps), false);
    assert.equal(d.prompts.length, 1);
  });

  it("falls back to the PIN or passcode on a phone with no biometrics enrolled", async () => {
    const d = deviceWith(SECRET, { passes: true });
    assert.equal(await unlockWith(d.deps), true);
    assert.equal(d.prompts[0]!.disableDeviceFallback, false, "the device credential must be allowed");
  });

  it("stays locked when the prompt is cancelled or fails", async () => {
    const d = deviceWith(SECRET, { passes: false });
    assert.equal(await unlockWith(d.deps), false);
  });

  it("still asks when the security level cannot be read", async () => {
    const d = deviceWith(new Error("unavailable"), { passes: false });
    assert.equal(await unlockWith(d.deps), false);
    assert.equal(d.prompts.length, 1);
  });

  it("leaves a phone with no lock at all as it was", async () => {
    // Policy for unsecured phones is an open question; nothing changes here.
    const off = deviceWith(SECURITY_LEVEL_NONE, { enabled: false });
    assert.equal(await unlockWith(off.deps), true);
    assert.equal(off.prompts.length, 0);
    const on = deviceWith(SECURITY_LEVEL_NONE, { enabled: true });
    assert.equal(await unlockWith(on.deps), false);
  });
});
