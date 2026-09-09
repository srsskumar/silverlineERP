/**
 * Masked-PII display helpers. The API returns full sensitive fields as null
 * without permission alongside `*_last4` strings; the UI must never invent
 * values — it renders the full value when present, the masked last-4 when
 * only that is present, and a neutral placeholder otherwise.
 */

export const MASKED_PLACEHOLDER = '—';

export function displayMasked(
  value: string | number | null | undefined,
  last4?: string | null,
): string {
  if (value !== null && value !== undefined && String(value) !== '') return String(value);
  if (last4 !== null && last4 !== undefined && String(last4).trim() !== '') {
    return `•••• ${String(last4).trim()}`;
  }
  return MASKED_PLACEHOLDER;
}

/** True when only a masked last-4 (no full value) is available. */
export function isMaskedOnly(
  value: string | number | null | undefined,
  last4?: string | null,
): boolean {
  if (value !== null && value !== undefined && String(value) !== '') return false;
  return !!last4 && String(last4).trim() !== '';
}

export function displayEmployeeName(emp: { first_name?: unknown; last_name?: unknown }): string {
  const first = typeof emp.first_name === 'string' ? emp.first_name : '';
  const last = typeof emp.last_name === 'string' ? emp.last_name : '';
  return `${first} ${last}`.trim() || MASKED_PLACEHOLDER;
}
