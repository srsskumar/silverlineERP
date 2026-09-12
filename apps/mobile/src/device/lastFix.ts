/**
 * Last accepted punch fix, persisted across launches.
 *
 * Impossible-travel detection needs a previous position to compare against, and
 * the interesting case is exactly the one that spans an app restart: punch out
 * in one district, force-quit, punch in 200 km away two minutes later. Holding
 * it in memory would miss that.
 *
 * SecureStore is used because it is already the app's storage primitive and the
 * value is a precise location history point — low volume, one key.
 */

import * as SecureStore from "expo-secure-store";
import type { PunchFix } from "./location";

const KEY = "silverline.last_punch_fix";

export async function loadLastFix(): Promise<PunchFix | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PunchFix;
    // Guard against a partially written or schema-drifted value.
    if (typeof parsed?.latitude !== "number" || typeof parsed?.longitude !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveLastFix(fix: PunchFix): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(fix));
  } catch {
    // Never let a storage failure block a punch — the signal is advisory.
  }
}

/** Cleared on sign-out so one user's positions never seed another's checks. */
export async function clearLastFix(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Best effort.
  }
}
