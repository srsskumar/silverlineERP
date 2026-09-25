/**
 * Re-submitting a conflicted return from its review (final-review fix 1).
 *
 * The review is for the op's own day. It used to be built with today's work
 * date, so Monday's conflicted correction, reviewed on Tuesday, went in as a
 * new Tuesday return (or onto Tuesday's), and the Monday op was then
 * discarded: the correction was lost. Now:
 *   - the form is for review.payload.entry_date, and the submission is built
 *     for that date;
 *   - a past day needs a manager (the server refuses anyone else with
 *     PAST_DAY_AMENDMENT), so for crew the review says so up front and
 *     queues nothing; the op stays in the Sync queue;
 *   - the original op is discarded only after a replacement for the SAME day
 *     is queued successfully.
 */
import type { SurveyEntryInput, SurveyMeasure, VillageRover } from "../api/endpoints";
import type { ReturnDraft } from "./returnForm";
import { returnSubmission, type FiledEntry, type QueuedSurveyOp } from "./fieldCrew";

export const PAST_DAY_NOTICE =
  "Corrections to a past day need your PM; your figures are kept in the Sync queue.";

/** Which day the review is for, and whether this person may correct it. */
export function reviewDay(
  payload: Pick<SurveyEntryInput, "entry_date">,
  workDate: string,
  canManage: boolean,
): { date: string; pastDay: boolean; blocked: boolean; notice: string | null } {
  const date = String(payload.entry_date).slice(0, 10);
  const pastDay = date !== workDate;
  const blocked = pastDay && !canManage;
  return { date, pastDay, blocked, notice: blocked ? PAST_DAY_NOTICE : null };
}

export async function submitReview(args: {
  review: { clientUuid: string; payload: SurveyEntryInput };
  village: Parameters<typeof returnSubmission>[0]["village"];
  measures: SurveyMeasure[];
  draft: ReturnDraft;
  kit: VillageRover[];
  /** The op's day as the server holds it now; its version is the base. */
  filed: FiledEntry | null;
  /** Today, for telling a past day from today. */
  workDate: string;
  canManage: boolean;
  enqueue(op: QueuedSurveyOp<SurveyEntryInput>): Promise<string>;
  discard(clientUuid: string): Promise<void>;
}): Promise<{ ok: true; message: string } | { ok: false; problems: string[] }> {
  const plan = reviewDay(args.review.payload, args.workDate, args.canManage);
  if (plan.blocked) return { ok: false, problems: [plan.notice!] };
  const built = returnSubmission({
    village: args.village, workDate: plan.date, measures: args.measures,
    draft: args.draft, kit: args.kit, filed: args.filed,
  });
  if (!built.ok) return { ok: false, problems: built.problems };
  if (built.op.payload.entry_date !== plan.date) {
    return { ok: false, problems: ["The correction was built for the wrong day. Nothing was changed."] };
  }
  // Throws if the replacement cannot be queued; the original then stays.
  const message = await args.enqueue(built.op);
  await args.discard(args.review.clientUuid);
  return { ok: true, message };
}
