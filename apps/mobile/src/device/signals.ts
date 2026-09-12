/**
 * Device-side anti-fraud signals attached to a punch.
 *
 * The heuristics themselves live in @silverline/shared so the server runs the
 * identical check — this file is only the part that needs the native device
 * APIs. Everything collected here is advisory and never blocks a punch.
 */

import * as Device from "expo-device";
import {
  detectMovementAnomaly,
  looksLikeEmulator,
  MAX_PLAUSIBLE_SPEED_MPS,
  type MovementAnomaly,
} from "@silverline/shared";
import type { PunchFix } from "./location";

export { detectMovementAnomaly, looksLikeEmulator, MAX_PLAUSIBLE_SPEED_MPS };
export type { MovementAnomaly };

export interface DeviceSignals {
  /** False on a simulator/emulator — the platform's own hardware check. */
  is_physical_device: boolean;
  device_type: string | null;
  os_name: string | null;
  os_version: string | null;
  manufacturer: string | null;
  model_name: string | null;
  /** Android only: OS build fingerprint, blank on a stock emulator image. */
  os_build_id: string | null;
  /** True when the device looks like an emulator on name/model heuristics. */
  suspected_emulator: boolean;
}

export function collectDeviceSignals(): DeviceSignals {
  const modelName = Device.modelName ?? null;
  const manufacturer = Device.manufacturer ?? null;
  const osBuildId = Device.osBuildId ?? null;
  return {
    is_physical_device: Device.isDevice,
    device_type: Device.deviceType != null ? String(Device.deviceType) : null,
    os_name: Device.osName ?? null,
    os_version: Device.osVersion ?? null,
    manufacturer,
    model_name: modelName,
    os_build_id: osBuildId,
    suspected_emulator:
      !Device.isDevice || looksLikeEmulator(modelName, manufacturer, osBuildId),
  };
}

/** Everything attached to a punch for server-side review scoring. */
export interface PunchSignals {
  device: DeviceSignals;
  movement: MovementAnomaly | null;
  /** Convenience flag: any signal that warrants a manual look. */
  review_suggested: boolean;
}

export function buildPunchSignals(
  previous: PunchFix | null,
  current: PunchFix,
): PunchSignals {
  const device = collectDeviceSignals();
  const movement = detectMovementAnomaly(previous, current);
  return {
    device,
    movement,
    review_suggested:
      device.suspected_emulator ||
      current.mocked ||
      movement?.impossible_travel === true,
  };
}
