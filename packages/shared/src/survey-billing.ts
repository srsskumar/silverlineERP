import { z } from 'zod';

/**
 * Turning measured survey work into a running-account bill (§note 9).
 *
 * The survey module records acres surveyed per village per day. The billing
 * module raises bills against a BOQ, each line carrying a cumulative measured
 * quantity. They measure the same work, and until now nothing joined them:
 * the quantity on the bill was typed in from a spreadsheet kept alongside the
 * system.
 *
 * Two measurements of one job drift. On a government contract the bill has to
 * tie to the measurement book, and a drift is a rejected bill or a dispute
 * months later with nobody able to say which number was right.
 *
 * What this produces is a *proposal*, never a bill. A measurement book is
 * certified by an engineer who walks the ground; software that billed
 * automatically from its own records would be asserting something it is not
 * in a position to assert. The operator reviews every line and can change any
 * of them before anything is raised.
 */

export const surveyBoqLinkSchema = z.object({
  boq_item_id: z.string().uuid(),
  measure_id: z.string().uuid(),
  /**
   * Bill this line only for villages that have reached this stage.
   *
   * Ground truthing is not a finished parcel. Billing a village that has been
   * walked but not vectorised, QC'd and published claims work that cannot be
   * certified, and it comes back as a deduction on the next bill.
   */
  stage_id: z.string().uuid().nullable().optional(),
  /** BOQ units per measure unit — hectares per acre, say. */
  factor: z.number().positive().finite().max(1_000_000).default(1),
});

export type SurveyBoqLink = z.infer<typeof surveyBoqLinkSchema>;

/** Why a proposed line is worth a second look before it is billed. */
export const PROPOSAL_FLAGS = {
  EXCEEDS_BOQ: 'The measured quantity is more than the BOQ allows for this item',
  BELOW_CERTIFIED: 'Less has been measured than was already certified on an earlier bill',
  NOTHING_NEW: 'Nothing further has been measured since the last certified bill',
  UNDATED_COMPLETIONS:
    'Some villages have finished this stage without a completion date, so they are '
    + 'not counted. Set their dates to bill them.',
} as const;

export type ProposalFlag = keyof typeof PROPOSAL_FLAGS;

export interface MeasuredLineInput {
  /** Cumulative quantity measured up to the bill date, in measure units. */
  measuredQuantity: number;
  /** BOQ units per measure unit. */
  factor: number;
  /** What earlier certified bills already claimed for this item. */
  previousQuantity: number;
  /** The BOQ's own quantity for the item. */
  boqQuantity: number;
  /** Villages that finished the gating stage but carry no completion date. */
  undatedVillages?: number;
}

export interface MeasuredLine {
  /** Measured quantity converted into the BOQ's unit, rounded to 3 places. */
  cumulativeQuantity: number;
  previousQuantity: number;
  thisQuantity: number;
  flags: ProposalFlag[];
}

/** 3 decimals, which is what the quantity columns hold. */
function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/**
 * One proposed line, with everything about it that deserves a second look.
 *
 * Nothing is clamped. A measured quantity above the BOQ is a real thing that
 * happens — the ground had more land in it than the tender estimated — and
 * silently capping it would hide a variation the contract has a process for.
 * It is flagged and left alone, for a person to decide.
 */
export function measuredLine(input: MeasuredLineInput): MeasuredLine {
  const cumulative = round3(input.measuredQuantity * input.factor);
  const previous = round3(input.previousQuantity);
  const flags: ProposalFlag[] = [];

  if (cumulative > input.boqQuantity) flags.push('EXCEEDS_BOQ');
  if (cumulative < previous) flags.push('BELOW_CERTIFIED');
  else if (round3(cumulative - previous) === 0) flags.push('NOTHING_NEW');
  if ((input.undatedVillages ?? 0) > 0) flags.push('UNDATED_COMPLETIONS');

  return {
    cumulativeQuantity: cumulative,
    previousQuantity: previous,
    thisQuantity: round3(cumulative - previous),
    flags,
  };
}

/**
 * Whether a proposal is worth showing as ready to raise.
 *
 * A proposal where every line has nothing new on it is a bill for nothing,
 * and the billing engine refuses those anyway. Saying so up front is kinder
 * than letting somebody fill in a period and a remark first.
 */
export function proposalHasWork(lines: Pick<MeasuredLine, 'thisQuantity'>[]): boolean {
  return lines.some(l => l.thisQuantity > 0);
}
