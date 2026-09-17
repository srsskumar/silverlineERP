import { describe, expect, it } from 'vitest';
import {
  measuredLine, proposalHasWork, surveyBoqLinkSchema, PROPOSAL_FLAGS,
} from './survey-billing.js';

/**
 * Turning what the field measured into what the contract pays for.
 *
 * Every number here ends up on a bill sent to a government department, so
 * the interesting cases are the ones where the honest answer is awkward:
 * more ground than the tender allowed for, a village re-measured downwards,
 * a stage finished but never dated.
 */

const line = (over: Partial<Parameters<typeof measuredLine>[0]> = {}) => measuredLine({
  measuredQuantity: 100, factor: 1, previousQuantity: 0, boqQuantity: 1000, ...over,
});

describe('what this bill claims', () => {
  it('is the measured total less what was already certified', () => {
    // A running-account bill states the total to date; the engine works out
    // this bill's share by subtracting the last certified total.
    const r = line({ measuredQuantity: 250, previousQuantity: 100 });
    expect(r.cumulativeQuantity).toBe(250);
    expect(r.previousQuantity).toBe(100);
    expect(r.thisQuantity).toBe(150);
  });

  it('converts the field unit into the contract unit', () => {
    // The field records acres because that is how it is walked; the BOQ may
    // be written in hectares because that is how it was drafted.
    const r = line({ measuredQuantity: 100, factor: 0.404686 });
    expect(r.cumulativeQuantity).toBe(40.469);
  });

  it('rounds to the three places the quantity column holds', () => {
    const r = line({ measuredQuantity: 1 / 3, factor: 1 });
    expect(r.cumulativeQuantity).toBe(0.333);
  });
});

describe('the awkward cases, said out loud', () => {
  it('flags more ground than the BOQ allowed for, and does not quietly cap it', () => {
    // The ground had more land in it than the tender estimated. That is a
    // variation with a process attached, not a rounding error to hide.
    const r = line({ measuredQuantity: 1200, boqQuantity: 1000 });
    expect(r.cumulativeQuantity).toBe(1200);
    expect(r.flags).toContain('EXCEEDS_BOQ');
  });

  it('flags a downward revision rather than billing a negative', () => {
    // A re-measure found less than the last bill certified. Somebody has to
    // decide what happens; the system should not decide silently.
    const r = line({ measuredQuantity: 80, previousQuantity: 100 });
    expect(r.thisQuantity).toBe(-20);
    expect(r.flags).toContain('BELOW_CERTIFIED');
  });

  it('flags a line with nothing new on it', () => {
    const r = line({ measuredQuantity: 100, previousQuantity: 100 });
    expect(r.thisQuantity).toBe(0);
    expect(r.flags).toContain('NOTHING_NEW');
  });

  it('does not call a downward revision "nothing new"', () => {
    // They are different problems and only one of them is benign.
    const r = line({ measuredQuantity: 80, previousQuantity: 100 });
    expect(r.flags).not.toContain('NOTHING_NEW');
  });

  it('says when villages were left out for want of a completion date', () => {
    // Silently under-billing is the worse failure: nobody notices money that
    // was never claimed.
    const r = line({ undatedVillages: 4 });
    expect(r.flags).toContain('UNDATED_COMPLETIONS');
  });

  it('says nothing about dates when every completion has one', () => {
    expect(line({ undatedVillages: 0 }).flags).not.toContain('UNDATED_COMPLETIONS');
  });

  it('can raise more than one flag at once', () => {
    const r = line({ measuredQuantity: 1200, boqQuantity: 1000, previousQuantity: 1200, undatedVillages: 2 });
    expect(r.flags).toEqual(expect.arrayContaining(['EXCEEDS_BOQ', 'NOTHING_NEW', 'UNDATED_COMPLETIONS']));
  });

  it('gives every flag words a person can read', () => {
    for (const flag of Object.keys(PROPOSAL_FLAGS)) {
      expect(PROPOSAL_FLAGS[flag as keyof typeof PROPOSAL_FLAGS].length).toBeGreaterThan(20);
    }
  });
});

describe('whether there is anything to raise', () => {
  it('is false when nothing has moved since the last bill', () => {
    expect(proposalHasWork([{ thisQuantity: 0 }, { thisQuantity: 0 }])).toBe(false);
  });

  it('is true when one line has moved', () => {
    expect(proposalHasWork([{ thisQuantity: 0 }, { thisQuantity: 12.5 }])).toBe(true);
  });

  it('is false for a proposal of only downward revisions', () => {
    // The billing engine refuses a bill claiming no additional work, so
    // offering to raise one would walk somebody into a wall.
    expect(proposalHasWork([{ thisQuantity: -20 }])).toBe(false);
  });

  it('is false when there is nothing at all', () => {
    expect(proposalHasWork([])).toBe(false);
  });
});

describe('what a link will accept', () => {
  const ok = {
    boq_item_id: '11111111-1111-4111-8111-111111111111',
    measure_id: '22222222-2222-4222-8222-222222222222',
  };

  it('defaults the factor to one, because units usually already agree', () => {
    const r = surveyBoqLinkSchema.parse(ok);
    expect(r.factor).toBe(1);
    expect(r.stage_id).toBeUndefined();
  });

  it('refuses a factor of zero, which would bill every line as nothing', () => {
    for (const bad of [0, -1]) {
      expect(surveyBoqLinkSchema.safeParse({ ...ok, factor: bad }).success, `${bad}`).toBe(false);
    }
  });

  it('refuses a factor that is not a number at all', () => {
    for (const bad of ['two', Infinity, NaN]) {
      expect(surveyBoqLinkSchema.safeParse({ ...ok, factor: bad }).success, `${bad}`).toBe(false);
    }
  });

  it('refuses identifiers that are not identifiers', () => {
    expect(surveyBoqLinkSchema.safeParse({ ...ok, boq_item_id: 'abc' }).success).toBe(false);
    expect(surveyBoqLinkSchema.safeParse({ ...ok, measure_id: '' }).success).toBe(false);
  });

  it('takes a null stage, meaning the measurement itself is the deliverable', () => {
    expect(surveyBoqLinkSchema.parse({ ...ok, stage_id: null }).stage_id).toBeNull();
  });
});
