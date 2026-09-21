/**
 * The server's word that this device has been revoked, and so the signal to
 * wipe it. The API sends it from login and from refresh today; the client
 * treats it the same from any endpoint, because a revoked device that only
 * wipes on one particular request keeps its data until it happens to make it.
 */
export const DEVICE_REVOKED = "DEVICE_REVOKED";

/** True for an error body -- or a thrown ApiError -- carrying the revoke code. */
export function isDeviceRevoked(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === DEVICE_REVOKED
  );
}
