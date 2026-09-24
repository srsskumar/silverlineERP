import { describe, expect, it } from 'vitest';
import { holidayEditPatchBody } from '../lib/holidays';

/**
 * A-012: the edit dialog PATCHes only what actually changed, plus the
 * reason the API always requires. Pinned separately from the dom test so
 * the diffing logic itself — not just one example wired through a form —
 * is covered.
 */
describe('holiday edit PATCH body', () => {
  const original = { date: '2026-05-01', name: 'Labour Day', type: 'national' };

  it('sends only the reason when nothing changed', () => {
    expect(holidayEditPatchBody(original, { ...original, reason: 'No-op check' }))
      .toEqual({ reason: 'No-op check' });
  });

  it('sends only the fields that changed, alongside the reason', () => {
    expect(holidayEditPatchBody(original, { ...original, name: 'Labor Day', reason: 'Fixed the spelling' }))
      .toEqual({ name: 'Labor Day', reason: 'Fixed the spelling' });
  });

  it('sends every field that changed at once', () => {
    expect(holidayEditPatchBody(original, {
      date: '2026-05-02', name: 'Labor Day', type: 'manual', reason: 'Moved and renamed',
    })).toEqual({ date: '2026-05-02', name: 'Labor Day', type: 'manual', reason: 'Moved and renamed' });
  });
});
