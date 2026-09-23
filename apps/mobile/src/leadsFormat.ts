/**
 * Pure display/validation helpers for the Pipeline (leads) screen — kept
 * dependency-free and separate from the screen file, same reasoning as
 * approvalsFormat.ts/documentsFormat.ts (see their headers).
 */

/** Mirrors packages/shared/src/crm.ts's LEAD_STAGES. */
const LEAD_STAGE_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  TENDER_IDENTIFIED: "Tender identified",
  CONVERTED: "Converted",
  LOST: "Lost",
  DISQUALIFIED: "Disqualified",
};

export function formatLeadStage(stage: string): string {
  return LEAD_STAGE_LABELS[stage] ?? stage;
}

export function leadStageTone(
  stage: string,
): "success" | "warning" | "danger" | "neutral" | "info" {
  if (stage === "CONVERTED") return "success";
  if (stage === "LOST" || stage === "DISQUALIFIED") return "danger";
  if (stage === "NEW") return "neutral";
  return "info";
}

/**
 * Client-side mirror of the server's leadStageSchema refine
 * (packages/shared/src/crm.ts): moving to LOST or DISQUALIFIED must carry a
 * reason. Checked here so a stage change with no reason fails on the phone
 * instead of round-tripping to learn the same thing.
 */
export function validateLeadStageChange(
  stage: string,
  lostReason: string,
): { ok: boolean; error: string | null } {
  if ((stage === "LOST" || stage === "DISQUALIFIED") && lostReason.trim().length === 0) {
    return { ok: false, error: "Record why the lead was lost or disqualified." };
  }
  return { ok: true, error: null };
}
