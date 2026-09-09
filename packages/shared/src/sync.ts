import { z } from "zod";

/**
 * Offline-sync state union (ARCHITECTURE.md §7.1 + DEV_PLAN.md §3).
 * Server responses map onto these states client-side.
 */
export const syncStateSchema = z.enum([
  "QUEUED",
  "SYNCING",
  "SYNCED",
  "FAILED",
  "CONFLICT",
  "REJECTED",
]);

export type SyncState = z.infer<typeof syncStateSchema>;

const TERMINAL_SYNC_STATES: readonly SyncState[] = [
  "SYNCED",
  "FAILED",
  "CONFLICT",
  "REJECTED",
];

/** True when no further sync attempts will happen without client action. */
export function isSyncTerminalState(state: SyncState): boolean {
  return TERMINAL_SYNC_STATES.includes(state);
}

/**
 * Build a client-generated idempotency key (`Idempotency-Key` header).
 * Server treats a repeated key as ALREADY_APPLIED → SYNCED.
 */
export function createIdempotencyKey(prefix = "idem"): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rand}`;
}

/** Guard for inbound `Idempotency-Key` header values. */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 8 && key.length <= 255;
}
