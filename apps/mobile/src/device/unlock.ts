/**
 * Whether the app may unlock after sitting in the background, with
 * expo-local-authentication injected so the decision runs under node.
 *
 * The lock used to prompt only for people who had switched biometric unlock on
 * in More; for everyone else it answered "unlocked" without asking, so the
 * five-minute background lock did nothing for most users. It now asks the
 * operating system for whatever the device is secured with -- fingerprint, face,
 * or the PIN, pattern or passcode when there is no biometric -- because the
 * device credential fallback is left on.
 */

/** expo-local-authentication's SecurityLevel.NONE: no PIN, pattern, passcode or biometric. */
export const SECURITY_LEVEL_NONE = 0;

export interface UnlockDeps {
  getEnrolledLevelAsync(): Promise<number>;
  authenticateAsync(options: {
    promptMessage: string;
    disableDeviceFallback: boolean;
  }): Promise<{ success: boolean }>;
  /** The More screen's biometric unlock switch. */
  biometricEnabled(): Promise<boolean>;
}

export async function unlockWith(deps: UnlockDeps): Promise<boolean> {
  // An error reading the level is not evidence the device is unsecured; ask,
  // and let the prompt itself fail if there is nothing to ask with.
  const level = await deps.getEnrolledLevelAsync().catch(() => null);
  if (level === SECURITY_LEVEL_NONE) {
    // A phone with no lock at all has nothing to prompt for. Whether such a
    // phone should be allowed to use the app is a policy question left open:
    // it unlocks as it always has, unless the user asked for biometric unlock
    // and has since removed it from the phone, which stays locked as before.
    return !(await deps.biometricEnabled());
  }
  const result = await deps.authenticateAsync({
    promptMessage: "Unlock Silverline",
    disableDeviceFallback: false,
  });
  return result.success;
}
