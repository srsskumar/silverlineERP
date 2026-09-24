/**
 * The day's return, assembled and checked on the device.
 *
 * Everything here runs before the return is queued, and that is the whole
 * point of it. A village with no signal files into the outbox, which may not
 * reach the server for hours; by then the crew has walked out and a refusal
 * has nobody to ask. So every rule the server will apply is applied here
 * first, using the server's own functions from @silverline/shared rather than
 * a second copy that drifts.
 *
 * What cannot be checked here is checked there and nowhere else: whether the
 * village already has a return for the day, and whether the instrument is
 * issued to the person filing. Both need the database.
 */
import {
  checkLowProgress,
  checkRoverDay,
  gtReasonRequired,
  reasonNeedsRemarks,
  surveyEntrySchema,
  toFieldErrors,
  type FieldError,
  type RoverDayStatus,
} from "@silverline/shared";
import type { RoverDayInput, SurveyEntryInput, SurveyMeasure } from "../api/endpoints";

/** One instrument's line on the form, as typed. */
export interface RoverDraft {
  status: RoverDayStatus;
  idleReason: string | null;
  remarks: string;
}

export interface ReturnDraft {
  /** Measure code → what was typed. Kept as text so a half-typed "1." is not a 1. */
  quantities: Record<string, string>;
  /** Asset id → that instrument's day. */
  rovers: Record<string, RoverDraft>;
  govtStaffPresent: string;
  crewPresent: string;
  /** Teams out in the village today (§59.4.2). Blank means not asked. */
  teamsDeployed: string;
  /** The version of a filed day this draft corrects, pinned when it was filled. */
  baseVersion?: number;
  /** The crew asked to clear the note on a filed day. */
  clearNotes?: boolean;
  notes: string;
  lowProgressReason: string | null;
  lowProgressRemarks: string;
  /** Why ground truthing has run past its date, when the server will ask. */
  gtVarianceReason: string | null;
  gtVarianceRemarks: string;
}

export function emptyDraft(): ReturnDraft {
  return {
    quantities: {},
    rovers: {},
    govtStaffPresent: "",
    crewPresent: "",
    teamsDeployed: "",
    notes: "",
    lowProgressReason: null,
    lowProgressRemarks: "",
    gtVarianceReason: null,
    gtVarianceRemarks: "",
  };
}

/**
 * A typed number, or a reason it is not one.
 *
 * Blank is `null` rather than 0 throughout: on the attendance fields the
 * difference is the finding. Null means nobody was asked; zero means nobody
 * came, and only one of those is worth a supervisor's morning.
 */
export function parseNumber(
  text: string,
  label: string,
  opts: { integer?: boolean } = {},
): { value: number | null; error?: string } {
  const raw = text.trim();
  if (raw === "") return { value: null };
  // Not Number(): that reads "" as 0, "12abc" as NaN but " 12 " as 12, and
  // accepts "1e5" from a fat-fingered keypad.
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return { value: null, error: `${label} must be a number. "${raw.slice(0, 20)}" is not one.` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { value: null, error: `${label} is not a number this app can use.` };
  }
  if (opts.integer && !Number.isInteger(value)) {
    return { value: null, error: `${label} counts people, so it has to be a whole number.` };
  }
  return { value };
}

/** Acres recorded today: the extent-based measures, and only those. */
export function extentToday(
  quantities: Record<string, string>,
  measures: SurveyMeasure[],
): number {
  let total = 0;
  for (const m of measures) {
    if (m.basis !== "EXTENT") continue;
    const { value } = parseNumber(quantities[m.code] ?? "", m.label);
    total += value ?? 0;
  }
  return total;
}

export type BuildResult =
  | { ok: true; entry: SurveyEntryInput; warnings: string[] }
  | {
      ok: false;
      problems: string[];
      /** The schema's refusals by field, for a form that marks the field itself. */
      fieldErrors?: FieldError[];
    };

/**
 * Turn the form into the entry the server takes, or say what is wrong with it.
 *
 * Every problem at once rather than one per attempt: a crew member standing
 * in a field at dusk should be told everything the form needs, not sent round
 * the loop four times.
 */
export function buildEntry(args: {
  villageId: string;
  entryDate: string;
  measures: SurveyMeasure[];
  draft: ReturnDraft;
  lowProgressThresholdAc: number | null;
  /** Ground truthing's plan, so the device can ask what the server will. */
  groundTruthing?: {
    state?: string | null;
    expectedEndOn?: string | null;
    completedOn?: string | null;
    varianceReason?: string | null;
  } | null;
  /** The village's business day, for measuring lateness against. */
  today?: string;
  /**
   * Correcting a filed day: a typed 0 is an entry ("take this figure off"),
   * not a blank, so it is sent.
   */
  keepZeros?: boolean;
}): BuildResult {
  const { draft, measures } = args;
  const problems: string[] = [];
  const warnings: string[] = [];

  const values: Record<string, number> = {};
  for (const m of measures) {
    const { value, error } = parseNumber(draft.quantities[m.code] ?? "", m.label);
    if (error) problems.push(error);
    // A zero is not sent. The absence of a measure means nothing was done
    // against it, which is what a typed 0 means, and sending both makes two
    // spellings of one fact.
    else if (value !== null && (value > 0 || (args.keepZeros && value === 0))) values[m.code] = value;
  }

  const rovers: RoverDayInput[] = Object.entries(draft.rovers).map(([assetId, r]) => ({
    asset_id: assetId,
    status: r.status,
    idle_reason: r.status === "IDLE" ? r.idleReason : null,
    remarks: r.remarks.trim() || null,
  }));

  // The server's own check, run here so its wording is the wording the crew
  // reads either way.
  problems.push(...checkRoverDay(rovers.map(r => ({
    assetId: r.asset_id,
    status: r.status as RoverDayStatus,
    idleReason: r.idle_reason,
    remarks: r.remarks,
  }))));

  const govt = parseNumber(draft.govtStaffPresent, "Government staff present", { integer: true });
  if (govt.error) problems.push(govt.error);
  const crew = parseNumber(draft.crewPresent, "Crew present", { integer: true });
  if (crew.error) problems.push(crew.error);
  // Teams out today (SG-008). Every phone-filed day was stored as zero teams
  // because the form never asked, and a supervisor's team-days read nought.
  const teams = parseNumber(draft.teamsDeployed ?? "", "Teams deployed");
  if (teams.error) problems.push(teams.error);
  else if (teams.value !== null && !Number.isInteger(teams.value)) {
    problems.push("Teams deployed counts teams, so it has to be a whole number.");
  }

  const low = checkLowProgress({
    areaToday: extentToday(draft.quantities, measures),
    threshold: args.lowProgressThresholdAc,
    roversOut: rovers.length,
  });
  if (low.needsReason && !draft.lowProgressReason) {
    problems.push(
      `Today's extent is below the ${low.threshold} acre threshold for this programme. `
      + "Say why before filing.",
    );
  }
  if (draft.lowProgressReason
      && reasonNeedsRemarks(draft.lowProgressReason)
      && !draft.lowProgressRemarks.trim()) {
    problems.push('A low-progress reason of "other" must say what happened.');
  }

  /*
   * Ground truthing past its date has to say why, and the server refuses the
   * day until it does. Asked here so the answer is given while somebody who
   * knows it is holding the phone — the outbox cannot ask, and a refusal
   * that surfaces tomorrow throws the day away.
   */
  const gtOverdue = args.groundTruthing
    ? gtReasonRequired(args.groundTruthing, args.today ?? args.entryDate)
    : false;
  if (gtOverdue && !draft.gtVarianceReason) {
    problems.push(
      `Ground truthing was due on ${args.groundTruthing?.expectedEndOn} and is still `
      + "open. Say why before recording another day — it is asked once.",
    );
  }
  if (draft.gtVarianceReason
      && reasonNeedsRemarks(draft.gtVarianceReason)
      && !draft.gtVarianceRemarks.trim()) {
    problems.push('A reason of "other" must say what happened.');
  }

  if (Object.keys(values).length === 0 && rovers.length === 0) {
    problems.push("Nothing is recorded. Enter a quantity, or account for the instruments.");
  }

  // Worth saying, not worth refusing: a day with quantities and nobody
  // recorded as present is filed all the time by a lone surveyor.
  if (Object.keys(values).length > 0 && crew.value === null && govt.value === null) {
    warnings.push("Nobody is recorded as present. Leave the attendance blank only if it was not asked.");
  }

  if (problems.length) return { ok: false, problems };

  const entry: SurveyEntryInput = {
      survey_village_id: args.villageId,
      entry_date: args.entryDate,
      values,
      ...(rovers.length ? { rovers } : {}),
      ...(teams.value !== null ? { teams_deployed: teams.value } : {}),
      ...(draft.notes.trim() ? { notes: draft.notes.trim() } : draft.clearNotes ? { notes: null } : {}),
      ...(draft.lowProgressReason
        ? {
            low_progress_reason: draft.lowProgressReason,
            ...(draft.lowProgressRemarks.trim()
              ? { low_progress_remarks: draft.lowProgressRemarks.trim() }
              : {}),
          }
        : {}),
      govt_staff_present: govt.value,
      crew_present: crew.value,
      ...(draft.gtVarianceReason
        ? {
            gt_variance_reason: draft.gtVarianceReason,
            ...(draft.gtVarianceRemarks.trim()
              ? { gt_variance_remarks: draft.gtVarianceRemarks.trim() }
              : {}),
          }
        : {}),
  };

  /*
   * The server's own schema, run on the device before anything is queued.
   *
   * The checks above are the ones with a story to tell; this is everything
   * else the server will refuse -- a crew of five thousand, a quantity past
   * what the column holds, a date that has not happened, a note too long to
   * store. Skipped, each of those went into the outbox, reached the server
   * hours later, and came back refused to a phone whose owner had long left
   * the village. Worded by the same function the server words its refusals
   * with, with the measure's label in place of its code.
   */
  const checked = surveyEntrySchema.safeParse(entry);
  if (!checked.success) {
    const fieldErrors = toFieldErrors(checked.error).map((fe) => {
      const code = fe.field.startsWith("values.") ? fe.field.slice("values.".length) : null;
      const measure = code ? measures.find((m) => m.code === code) : undefined;
      if (!measure) return fe;
      // A custom refusal ("larger than this field can hold") does not name
      // the field at all, and on a form of twenty figures that matters.
      const message = fe.message.includes(code!)
        ? fe.message.split(code!).join(measure.label)
        : `${measure.label}: ${fe.message}`;
      return { ...fe, message };
    });
    return { ok: false, problems: fieldErrors.map((fe) => fe.message), fieldErrors };
  }

  return { ok: true, warnings, entry };
}
