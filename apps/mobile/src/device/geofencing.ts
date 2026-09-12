/**
 * Native geofence monitoring.
 *
 * Until now the app took a single `getCurrentPositionAsync` fix at punch time
 * and let the server decide whether it fell inside a fence. That works for the
 * punch itself but tells the user nothing beforehand, and catches nothing while
 * the app is closed. `expo-location` can hand the OS a set of regions and be
 * woken on enter/exit instead — no polling, no battery cost — and
 * `expo-task-manager` was already a dependency for the sync worker.
 *
 * The OS caps how many regions it will watch (20 on iOS, 100 on Android), so
 * `nearestFences` trims to the closest ones around the user rather than
 * registering every fence in the organisation.
 */

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { isInsideFence, nearestRegions, type FenceShape } from "@silverline/shared";

export const GEOFENCE_TASK = "silverline-geofence";

/** iOS hard-limits monitored regions to 20; Android allows 100. */
export const MAX_MONITORED_REGIONS = 20;

export interface MonitoredFence {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
}

export type FenceTransition = "enter" | "exit";

export interface FenceEvent {
  fenceId: string;
  transition: FenceTransition;
  at: number;
}

/** In-memory log of the most recent transitions, newest first. */
const recent: FenceEvent[] = [];
const listeners = new Set<(event: FenceEvent) => void>();

export function recentFenceEvents(): readonly FenceEvent[] {
  return recent;
}

export function onFenceEvent(fn: (event: FenceEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Records a transition. Exported so the task handler and tests share a path. */
export function recordFenceEvent(event: FenceEvent): void {
  recent.unshift(event);
  // Bounded: this is a UI affordance, not an audit trail. The server keeps the
  // authoritative record when the punch is submitted.
  if (recent.length > 50) recent.length = 50;
  for (const fn of listeners) fn(event);
}

// Registered at module load so the OS can route a wake-up even when the app was
// killed — TaskManager requires the definition to exist before the event lands.
if (!TaskManager.isTaskDefined(GEOFENCE_TASK)) {
  TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const { eventType, region } = data as {
      eventType: Location.GeofencingEventType;
      region: Location.LocationRegion;
    };
    if (!region?.identifier) return;
    recordFenceEvent({
      fenceId: region.identifier,
      transition:
        eventType === Location.GeofencingEventType.Enter ? "enter" : "exit",
      at: Date.now(),
    });
  });
}

/**
 * Picks the fences worth handing to the OS: circles only (the platform APIs
 * take a centre and a radius), closest first, capped at the platform limit.
 * Polygon fences stay server-evaluated at punch time.
 */
export function nearestFences(
  fences: readonly MonitoredFence[],
  from: { latitude: number; longitude: number },
  limit: number = MAX_MONITORED_REGIONS,
): MonitoredFence[] {
  return nearestRegions(fences, from, limit);
}

/** True when the user granted the background ("always") location permission. */
export async function hasBackgroundPermission(): Promise<boolean> {
  const { status } = await Location.getBackgroundPermissionsAsync();
  return status === "granted";
}

/**
 * Requests background location. Must be called only AFTER foreground access is
 * granted — both platforms reject an "always" prompt that has no
 * "when in use" grant behind it, and Android 11+ sends the user to Settings
 * rather than showing a dialog.
 */
export async function requestBackgroundPermission(): Promise<boolean> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== "granted") return false;
  const background = await Location.requestBackgroundPermissionsAsync();
  return background.status === "granted";
}

/**
 * Starts (or restarts) monitoring. Returns the fences actually registered so
 * the UI can say how many of how many are being watched — silently dropping
 * fences past the platform cap would be worse than showing the number.
 */
export async function startFenceMonitoring(
  fences: readonly MonitoredFence[],
  from: { latitude: number; longitude: number },
): Promise<MonitoredFence[]> {
  if (!(await hasBackgroundPermission())) return [];
  const selected = nearestFences(fences, from);
  if (selected.length === 0) {
    await stopFenceMonitoring();
    return [];
  }
  await Location.startGeofencingAsync(
    GEOFENCE_TASK,
    selected.map((f) => ({
      identifier: f.id,
      latitude: f.latitude,
      longitude: f.longitude,
      // A zero or negative radius is rejected by the platform; clamp defensively.
      radius: Math.max(f.radius_m, 1),
      notifyOnEnter: true,
      notifyOnExit: true,
    })),
  );
  return selected;
}

export async function stopFenceMonitoring(): Promise<void> {
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
  }
}

export async function isMonitoring(): Promise<boolean> {
  return Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
}

/**
 * Which fence the user is standing in right now, evaluated on-device so the
 * punch screen can say "Inside Warehouse A" before anything is submitted.
 * The server still re-evaluates — this is guidance, never authorisation.
 */
export function fenceContaining(
  shapes: readonly { id: string; name: string; shape: FenceShape }[],
  at: { latitude: number; longitude: number },
): { id: string; name: string } | null {
  for (const entry of shapes) {
    if (isInsideFence(entry.shape, at.latitude, at.longitude)) {
      return { id: entry.id, name: entry.name };
    }
  }
  return null;
}
