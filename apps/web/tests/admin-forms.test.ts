import { describe, expect, it } from 'vitest';
import {
  auditQuery, roleAssignmentBody, settingsBody, settingsInitial, SCOPE_PICKERS,
} from '../lib/admin-forms';

/**
 * The administration forms, as data.
 *
 * The settings form used to open with defaults typed into the page, so an
 * administrator who corrected the organisation's name and pressed Save
 * also reset the session timeout to thirty minutes without any field ever
 * looking wrong. These pin the two halves of the fix: the form starts from
 * the record, and it sends only what was filled in.
 */
describe('organisation settings', () => {
  it('starts from what the organisation has set, and blank where nothing is', () => {
    const initial = settingsInitial({
      id: 'o1', name: 'Silverline',
      settings: { timezone: 'Asia/Kolkata', session_timeout_minutes: 720, match_tolerance: { rate_pct: 2 } },
    });
    expect(initial).toMatchObject({
      name: 'Silverline', timezone: 'Asia/Kolkata', session_timeout_minutes: '720',
      match_rate_pct: '2', match_quantity_pct: '', retention_days: '', locale: '',
      attendance_future_tolerance_minutes: '',
    });
    // The punch clock tolerance reads back the way it was set.
    expect(settingsInitial({ id: 'o3', settings: { attendance_future_tolerance_minutes: 2 } }).attendance_future_tolerance_minutes).toBe('2');
    // A brand-new organisation: nothing pretends to have been chosen.
    expect(settingsInitial({ id: 'o2', name: 'Demo Org', settings: {} }).session_timeout_minutes).toBe('');
    expect(settingsInitial(null).name).toBe('');
  });

  it('sends only the fields that were filled in, as numbers where the API wants numbers', () => {
    const body = settingsBody({
      name: 'Silverline ', timezone: 'Asia/Kolkata', locale: '', gst_state_code: '37',
      session_timeout_minutes: '720', retention_days: '', match_quantity_pct: '', match_rate_pct: '2.5', match_value_absolute: '',
    });
    expect(body).toEqual({
      name: 'Silverline',
      // Touching one tolerance field sends the whole triple -- see A-013
      // below -- with the two untouched ones explicitly null.
      settings: {
        timezone: 'Asia/Kolkata', gst_state_code: '37', session_timeout_minutes: 720,
        match_tolerance: { quantity_pct: null, rate_pct: 2.5, value_absolute: null },
      },
    });
    // Zero is a value: an organisation may refuse any forward skew at all.
    expect(settingsBody({ attendance_future_tolerance_minutes: '0' }).settings).toEqual({ attendance_future_tolerance_minutes: 0 });
    // Nothing filled: an empty merge rather than a row of blanks the API would refuse.
    expect(settingsBody({ name: '', timezone: '' })).toEqual({ settings: {} });
    // Touching no tolerance field at all leaves match_tolerance out entirely,
    // not sent as an empty/all-null object the API would have to no-op.
    expect(settingsBody({ name: 'X' }).settings).toEqual({});
  });

  it('A-013: clearing one tolerance sub-field while changing another keeps the untouched one, not blank', () => {
    // The organisation already has all three set (settingsInitial pre-fills
    // them); the operator blanks "Rate tolerance" and edits "Quantity
    // tolerance", leaving "Value tolerance" exactly as shown.
    const body = settingsBody({
      match_quantity_pct: '6', match_rate_pct: '', match_value_absolute: '100',
    });
    expect(body.settings.match_tolerance).toEqual({
      quantity_pct: 6, rate_pct: null, value_absolute: 100,
    });
  });
});

describe('assigning a role', () => {
  it('reads the scope from whichever picker was used', () => {
    expect(roleAssignmentBody({ role_id: 'r1' })).toEqual({ roles: [{ role_id: 'r1', scope_type: null, scope_id: null }] });
    expect(roleAssignmentBody({ role_id: 'r1', scope_project: 'p9' }))
      .toEqual({ roles: [{ role_id: 'r1', scope_type: 'project', scope_id: 'p9' }] });
    expect(roleAssignmentBody({ role_id: 'r1', scope_village: 'v3' }).roles[0]).toMatchObject({ scope_type: 'village', scope_id: 'v3' });
    // Blank pickers are not scopes.
    expect(roleAssignmentBody({ role_id: 'r1', scope_team: '', scope_mandal: '' }).roles[0].scope_type).toBeNull();
  });

  it('offers exactly the scope types the API accepts', () => {
    expect(SCOPE_PICKERS.map((p) => p.scope_type).sort()).toEqual(['district', 'mandal', 'project', 'team', 'village']);
  });
});

describe('asking the audit trail', () => {
  it('sends only the filters that are set, under the names the API takes', () => {
    expect(auditQuery({})).toBe('limit=50');
    const q = new URLSearchParams(auditQuery({
      action: 'user.create', entity: ' ', actorId: 'u1', entityId: 'e1', from: '2026-09-01', to: '2026-09-22', cursor: 'abc', limit: 20,
    }));
    expect(Object.fromEntries(q)).toEqual({
      limit: '20', action: 'user.create', actor_id: 'u1', entity_id: 'e1', from: '2026-09-01', to: '2026-09-22', cursor: 'abc',
    });
  });
});
