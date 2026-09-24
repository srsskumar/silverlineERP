/**
 * Pure validation helper for the Clients screen's create form — dependency-
 * free, same reasoning as leadsFormat.ts/tendersFormat.ts (see their
 * headers).
 */

/** Mirrors packages/shared/src/crm.ts's CLIENT_TYPES. */
export const CLIENT_TYPES = ["GOVERNMENT", "PRIVATE"] as const;

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Task 5d: client-side mirror of clientBaseSchema's two REQUIRED fields
 * (name, client_type) — `code` is derived server-side when omitted, exactly
 * like the desktop form leaves it. Everything else the schema accepts
 * (GSTIN/PAN, address, credit terms…) stays a desktop-only field.
 */
export function validateClientCreate(input: {
  name: string;
  client_type: string;
}): { ok: boolean; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!input.name.trim()) {
    errors.push({ field: "name", message: "A name is required" });
  }
  if (!(CLIENT_TYPES as readonly string[]).includes(input.client_type)) {
    errors.push({ field: "client_type", message: "Select whether this is a government or private client" });
  }
  return { ok: errors.length === 0, errors };
}
