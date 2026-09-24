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

/** Mirrors packages/shared/src/crm.ts's leadSchema.source enum. */
export const LEAD_SOURCES = [
  "REFERRAL",
  "PORTAL_WATCH",
  "COLD_OUTREACH",
  "EXISTING_CLIENT",
  "OTHER",
] as const;

const LEAD_SOURCE_LABELS: Record<string, string> = {
  REFERRAL: "Referral",
  PORTAL_WATCH: "Portal watch",
  COLD_OUTREACH: "Cold outreach",
  EXISTING_CLIENT: "Existing client",
  OTHER: "Other",
};

export function formatLeadSource(source: string): string {
  return LEAD_SOURCE_LABELS[source] ?? source;
}

/** Mirrors packages/shared/src/crm.ts's CLIENT_TYPES, reused as leadSchema.lead_type. */
export const LEAD_TYPES = ["GOVERNMENT", "PRIVATE"] as const;

export interface LeadCreateFieldError {
  field: string;
  message: string;
}

export interface LeadCreateInput {
  lead_no: string;
  organization_name: string;
  lead_type: string;
  source: string;
  /** MA-008: optional; the raw text box value, checked before it is sent as a number. */
  estimated_value?: string;
}

/**
 * B-011: client-side mirror of packages/shared/src/crm.ts's leadSchema's
 * REQUIRED fields only (lead_no, organization_name, lead_type, source).
 * Every other field the schema accepts (client_id, contact_id,
 * project_type_id/category_id, owner_id, next_follow_up_date) is optional
 * there and deliberately not on this form — see pipeline.tsx's header.
 */
export function validateLeadCreate(
  input: LeadCreateInput,
): { ok: boolean; errors: LeadCreateFieldError[] } {
  const errors: LeadCreateFieldError[] = [];
  const leadNo = input.lead_no.trim();
  if (!leadNo) {
    errors.push({ field: "lead_no", message: "A lead number is required" });
  } else if (leadNo.length > 50) {
    errors.push({ field: "lead_no", message: "Lead number must be 50 characters or fewer" });
  }
  if (!input.organization_name.trim()) {
    errors.push({ field: "organization_name", message: "Organisation name is required" });
  }
  if (!(LEAD_TYPES as readonly string[]).includes(input.lead_type)) {
    errors.push({ field: "lead_type", message: "Select whether this is a government or private lead" });
  }
  if (!(LEAD_SOURCES as readonly string[]).includes(input.source)) {
    errors.push({ field: "source", message: "Select how this lead came in" });
  }
  const ev = input.estimated_value?.trim() ?? "";
  if (ev && !/^\d+(\.\d{1,2})?$/.test(ev)) {
    errors.push({ field: "estimated_value", message: "Estimated value must be an amount in rupees, like 150000 or 1500.50" });
  }
  return { ok: errors.length === 0, errors };
}
