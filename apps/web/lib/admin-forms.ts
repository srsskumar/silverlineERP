/**
 * The shapes behind the administration forms, kept pure so they can be
 * asserted without a browser.
 *
 * Two of these exist because of what the QA pass found on the live system:
 * the organisation settings form was born with hard-coded defaults rather
 * than the organisation's own values, so saving a new name silently reset
 * the session timeout to 30 minutes and retention to a year; and the role
 * form asked for a scope as a raw UUID, which nobody has to hand.
 */

export type FormValues = Record<string, unknown>;

export interface OrgSettingsRow {
  id?: string;
  name?: string | null;
  settings?: {
    timezone?: string;
    locale?: string;
    gst_state_code?: string;
    session_timeout_minutes?: number;
    attendance_future_tolerance_minutes?: number;
    retention_days?: number;
    match_tolerance?: { quantity_pct?: number; rate_pct?: number; value_absolute?: number };
  } | null;
}

/**
 * What the settings form starts from: the organisation as it stands.
 *
 * Blank where nothing has been set, so the field reads as unset rather than
 * as a default somebody appears to have chosen. The API's own fallbacks
 * (Asia/Kolkata, a week of idle time) still apply to a blank field, and
 * they are named in the hints, not smuggled in as values.
 */
export function settingsInitial(row: OrgSettingsRow | null | undefined): FormValues {
  const s = row?.settings ?? {};
  const m = s.match_tolerance ?? {};
  const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  return {
    name: text(row?.name),
    timezone: text(s.timezone),
    locale: text(s.locale),
    gst_state_code: text(s.gst_state_code),
    session_timeout_minutes: text(s.session_timeout_minutes),
    attendance_future_tolerance_minutes: text(s.attendance_future_tolerance_minutes),
    retention_days: text(s.retention_days),
    match_quantity_pct: text(m.quantity_pct),
    match_rate_pct: text(m.rate_pct),
    match_value_absolute: text(m.value_absolute),
  };
}

/**
 * The PATCH body for the values as edited.
 *
 * Only what was filled in goes over: the API merges `settings` into what is
 * stored, so sending a blank would not clear a value, it would fail
 * validation. A number field holds a string until here.
 */
export function settingsBody(values: FormValues): { name?: string; settings: Record<string, unknown> } {
  const str = (k: string) => { const v = values[k]; return v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim(); };
  const num = (k: string) => { const v = str(k); return v === undefined ? undefined : Number(v); };
  const settings: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined) settings[k] = v; };
  put('timezone', str('timezone'));
  put('locale', str('locale'));
  put('gst_state_code', str('gst_state_code'));
  put('session_timeout_minutes', num('session_timeout_minutes'));
  put('attendance_future_tolerance_minutes', num('attendance_future_tolerance_minutes'));
  put('retention_days', num('retention_days'));
  const tolerance: Record<string, number> = {};
  for (const [field, key] of [['match_quantity_pct', 'quantity_pct'], ['match_rate_pct', 'rate_pct'], ['match_value_absolute', 'value_absolute']] as const) {
    const v = num(field);
    if (v !== undefined) tolerance[key] = v;
  }
  if (Object.keys(tolerance).length) settings.match_tolerance = tolerance;
  const name = str('name');
  return { ...(name !== undefined ? { name } : {}), settings };
}

/** The pickers a role can be limited by, in the order they are offered. */
export const SCOPE_PICKERS = [
  { key: 'scope_project', scope_type: 'project', label: 'Only on this project', source: 'projects?limit=100' },
  { key: 'scope_team', scope_type: 'team', label: 'Only this team lead’s team', source: 'employees?limit=100&status=ACTIVE' },
  { key: 'scope_district', scope_type: 'district', label: 'Only in this district', source: 'org/units?type=district&limit=100' },
  { key: 'scope_mandal', scope_type: 'mandal', label: 'Only in this mandal', source: 'org/units?type=mandal&limit=100' },
  { key: 'scope_village', scope_type: 'village', label: 'Only in this village', source: 'org/units?type=village&limit=100' },
] as const;

/**
 * One role, optionally limited to one place or piece of work.
 *
 * The scope used to be typed in as a UUID next to a type dropdown. Now each
 * kind of scope is its own picker, and the type is whichever picker was
 * used. If more than one was, the first in the list wins: the API takes
 * exactly one scope per role row, and choosing the widest is at least
 * predictable. Everything blank means the whole organisation.
 */
export function roleAssignmentBody(values: FormValues): {
  roles: Array<{ role_id: string; scope_type: string | null; scope_id: string | null }>;
} {
  const chosen = SCOPE_PICKERS.find((p) => typeof values[p.key] === 'string' && String(values[p.key]).trim() !== '');
  return {
    roles: [{
      role_id: String(values.role_id ?? ''),
      scope_type: chosen ? chosen.scope_type : null,
      scope_id: chosen ? String(values[chosen.key]) : null,
    }],
  };
}

export interface AuditFilters {
  action?: string;
  entity?: string;
  actorId?: string;
  entityId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** The query string for GET /audit, with only the filters that are set. */
export function auditQuery(f: AuditFilters): string {
  const q = new URLSearchParams({ limit: String(f.limit ?? 50) });
  const set = (k: string, v: string | undefined) => { if (v && v.trim()) q.set(k, v.trim()); };
  set('action', f.action);
  set('entity', f.entity);
  set('actor_id', f.actorId);
  set('entity_id', f.entityId);
  set('from', f.from);
  set('to', f.to);
  set('cursor', f.cursor);
  return q.toString();
}
