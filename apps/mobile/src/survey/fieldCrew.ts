/**
 * The rules that keep a day filed in the village from being refused later.
 *
 * Pure functions, so every one can be tested without a phone. Each exists
 * because the server refused something the phone had already queued, and
 * the outbox drops what the server refuses: one day of a crew's work per
 * refusal (docs/qa/2026-09-24/findings-survey-gaps.md, SG-001 to SG-013).
 */
import {
  GCP_WARNING_NOTES,
  checkGcp,
  gtReasonRequired,
  reasonNeedsRemarks,
} from "@silverline/shared";
import type { SurveyEntryInput, SurveyMeasure, VillageRover } from "../api/endpoints";
import { emptyDraft, type ReturnDraft } from "./returnForm";
import { parseDecimal, type PointDraft } from "./controlPoint";

/* ------------------------------------------------------------ SG-001 */

/** A rover somebody else files for, with a sentence saying who. */
export interface OthersRover extends VillageRover {
  note: string;
}

/** A rover, as against the tripod and the radio that travelled with it. */
export function isSurveyInstrument(category: string | null | undefined): boolean {
  return String(category ?? "").toUpperCase() === "SURVEY";
}

/**
 * The village's kit, split the way the server will judge it.
 *
 * The return refuses a rover that is not issued to the person filing, or to
 * somebody who reports to them (ROVER_NOT_YOURS). The form used to list
 * every allocated rover. The second crew member marked the first one's rover
 * "in use", and the whole day came back refused. Now only the person's own
 * instruments are asked about, and the rest are named with who files for
 * them. `issued_to_me` missing (an older server) means offered, as before.
 */
export function partitionKit(kit: VillageRover[]): {
  mine: VillageRover[];
  others: OthersRover[];
  otherKitOut: number;
} {
  const out = kit.filter(r => r.out);
  const instruments = out.filter(r => isSurveyInstrument(r.category));
  return {
    mine: instruments.filter(r => r.issued_to_me !== false),
    others: instruments
      .filter(r => r.issued_to_me === false)
      .map(r => ({
        ...r,
        note: r.holder_name
          ? `Carried by ${r.holder_name}. They record its day, or their team lead does.`
          : "Allocated here but not issued to anybody. Your team lead records its day.",
      })),
    otherKitOut: out.length - instruments.length,
  };
}

/* ------------------------------------------------------------ SG-003 */

/** Today's return as the server holds it, for correcting from the phone. */
export interface FiledEntry {
  id: string;
  version: number;
  entry_date: string;
  teams_deployed?: number | null;
  notes?: string | null;
  govt_staff_present?: number | null;
  crew_present?: number | null;
  values?: Record<string, number> | null;
}

const text = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : String(n);

/**
 * The form, filled in with a day already filed.
 *
 * A crew member who typed 25 for 250 opens the village again and sees what
 * they sent, not a blank form. A blank form re-filed was refused as a second
 * return for the day, and the correction was lost with it.
 */
export function draftFromEntry(entry: FiledEntry, measures: SurveyMeasure[]): ReturnDraft {
  const quantities: Record<string, string> = {};
  for (const m of measures) {
    const v = entry.values?.[m.code];
    if (v !== undefined && v !== null && Number(v) !== 0) quantities[m.code] = String(Number(v));
  }
  return {
    ...emptyDraft(),
    quantities,
    teamsDeployed: entry.teams_deployed ? String(entry.teams_deployed) : "",
    govtStaffPresent: text(entry.govt_staff_present),
    crewPresent: text(entry.crew_present),
    notes: entry.notes ?? "",
  };
}

export interface EntryAmendment {
  values: Record<string, number>;
  teams_deployed?: number;
  notes?: string | null;
  govt_staff_present?: number | null;
  crew_present?: number | null;
  amendment_reason?: string;
}

/**
 * What to PATCH so the filed day matches the form.
 *
 * PATCH sets only the measures it names, so a measure taken off the form is
 * sent as zero, which the server treats as "remove". Anything unchanged is
 * left out, so the audit trail records the correction and not the whole
 * form again.
 */
export function amendmentFor(filed: FiledEntry, next: SurveyEntryInput): EntryAmendment {
  const before = filed.values ?? {};
  const values: Record<string, number> = {};
  for (const [code, q] of Object.entries(next.values ?? {})) {
    if (Number(before[code] ?? 0) !== Number(q)) values[code] = q;
  }
  for (const code of Object.keys(before)) {
    if (!(code in (next.values ?? {})) && Number(before[code]) !== 0) values[code] = 0;
  }
  const out: EntryAmendment = { values, amendment_reason: "Corrected from the phone on the day" };
  const teams = next.teams_deployed ?? 0;
  if (teams !== Number(filed.teams_deployed ?? 0)) out.teams_deployed = teams;
  const notes = next.notes?.trim() ? next.notes.trim() : null;
  if (notes !== (filed.notes?.trim() ? filed.notes.trim() : null)) out.notes = notes;
  const govt = next.govt_staff_present ?? null;
  if (govt !== (filed.govt_staff_present ?? null)) out.govt_staff_present = govt;
  const crew = next.crew_present ?? null;
  if (crew !== (filed.crew_present ?? null)) out.crew_present = crew;
  return out;
}

/* ------------------------------------------------------------ SG-004 */

export interface DeviceFix {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

/**
 * What the person should look at again before the point is filed.
 *
 * The same warnings the server returns, plus one it cannot see: coordinates
 * that are still the phone's own fix. The server never refuses any of these,
 * and it should not, but they were only shown after filing, on a sheet that
 * closed as soon as the point was queued. A phone fix is metres out and a
 * control point is not (§59.9.5), so an untouched fix gets asked about.
 */
export function pointConfirmations(draft: PointDraft, fix: DeviceFix | null): string[] {
  const lat = parseDecimal(draft.latitude, "Latitude").value;
  const lng = parseDecimal(draft.longitude, "Longitude").value;
  if (lat === null || lng === null) return [];
  const out = checkGcp(lat, lng).map(w => GCP_WARNING_NOTES[w]);
  if (fix
      && draft.latitude === fix.latitude.toFixed(6)
      && draft.longitude === fix.longitude.toFixed(6)) {
    out.push(
      `These are still this phone's own position${
        typeof fix.accuracy === "number" ? `, good to about ${Math.round(fix.accuracy)} m` : ""
      }, not the controller's. A control point needs the controller's figures.`,
    );
  }
  return out;
}

/* ------------------------------------------------------------ SG-013 */

export interface CrewStage {
  id: string;
  stage_code: string;
  stage_label: string;
  stage_state?: string | null;
  stage_started_on?: string | null;
  stage_expected_end_on?: string | null;
  stage_variance_reason?: string | null;
}

/**
 * Whether this person may mark their stage complete from the phone.
 *
 * Only the stage they are crewed on, which is the only kind of row the
 * village list holds, and only while it is running. The owner's rule
 * (2026-09-24): the assigned employee, their manager, a team lead, the
 * project manager or an admin completes a stage. The phone is the assigned
 * employee's screen, so a person not on that stage is never offered it.
 */
export function completionOffer(
  village: CrewStage,
  canEnter: boolean,
): { stageCode: string; label: string } | null {
  if (!canEnter) return null;
  if (village.stage_state !== "IN_PROGRESS") return null;
  return { stageCode: village.stage_code, label: village.stage_label };
}

export type StageCompletion =
  | { ok: true; body: {
      stage_code: string; state: "COMPLETED"; started_on: string | null; completed_on: string;
      variance_reason?: string; variance_remarks?: string;
    } }
  | { ok: false; problem: string };

/**
 * The completion the server will accept, or the question it would ask.
 *
 * Ground truthing signed off after its date needs a reason
 * (GT_VARIANCE_REASON_REQUIRED). Asked here, while somebody who knows it is
 * holding the phone. The start date goes back with it: the stage route
 * writes whatever start it is sent.
 */
export function buildStageCompletion(
  village: CrewStage,
  workDate: string,
  reason: string | null,
  remarks: string,
): StageCompletion {
  const body: Extract<StageCompletion, { ok: true }>["body"] = {
    stage_code: village.stage_code,
    state: "COMPLETED",
    started_on: village.stage_started_on ?? null,
    completed_on: workDate,
  };
  if (village.stage_code === "GROUND_TRUTHING" && gtReasonRequired({
    expectedEndOn: village.stage_expected_end_on ?? null,
    completedOn: workDate,
    varianceReason: village.stage_variance_reason ?? reason,
  }, workDate)) {
    return {
      ok: false,
      problem: `Ground truthing was due on ${village.stage_expected_end_on}. `
        + "Say why it finished late before signing it off.",
    };
  }
  if (reason) {
    if (reasonNeedsRemarks(reason) && !remarks.trim()) {
      return { ok: false, problem: 'A reason of "other" must say what happened.' };
    }
    body.variance_reason = reason;
    if (remarks.trim()) body.variance_remarks = remarks.trim();
  }
  return { ok: true, body };
}

/* ------------------------------------------- SG-003, in the outbox */

/**
 * Whether a refused filing is really a correction of a day already in.
 *
 * One return per village per day (§59.4.1), so a second filing for a day
 * that already has one comes back ALREADY_ENTERED. From the phone that is
 * nearly always the same person correcting what they sent: re-filing after
 * a typo, or a second filing queued while the first was still waiting for
 * signal. Dropping it lost the correction, so the outbox amends instead.
 */
export function isSecondFiling(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return Boolean(e && e.status === 409 && e.code === "ALREADY_ENTERED");
}

/**
 * Nothing left to change: the day already reads as the form does.
 *
 * Checked before amending, so a retry after a lost response (the amendment
 * landed, the phone never heard) is a success rather than a second PATCH
 * that the server would refuse as a reused key with a different body.
 */
export function isEmptyAmendment(a: EntryAmendment): boolean {
  return Object.keys(a.values).length === 0
    && Object.keys(a).every(k => k === "values" || k === "amendment_reason");
}
