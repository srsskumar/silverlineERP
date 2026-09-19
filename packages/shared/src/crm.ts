import { z } from 'zod';
import { dateStringSchema } from './s1.js';
import type { RoleCode } from './rbac.js';
import { isValidGstin, isValidPan, isValidUdyam } from './india.js';

/**
 * Commercial spine — CRM, tender and bid management (§6.3–6.5, §7, §8).
 *
 * These grants are the canonical source of truth, not the migration that seeds
 * them. `seed.ts` deletes and rebuilds role_permissions from these maps on
 * every run, so a grant that exists only in SQL is silently dropped the next
 * time anyone re-seeds.
 */
export const CRM_PERMISSIONS = [
  'client.read','client.manage',
  'lead.read','lead.manage','lead.convert',
  'tender.read','tender.manage','tender.submit','tender.award','tender.override','tender.convert',
  'instrument.read','instrument.manage',
] as const;

const READ_ONLY = ['client.read','lead.read','tender.read','instrument.read'];

export const CRM_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...CRM_PERMISSIONS],
  // Admin runs the pipeline but not the eligibility override: §4.1 keeps
  // exceptional overrides with Super Admin.
  ADMIN: CRM_PERMISSIONS.filter(p => p !== 'tender.override'),
  // §4: owns leads through tender identification, no approval authority — so
  // no submit, award or override.
  SALES_BD_EXECUTIVE: ['client.read','client.manage','lead.read','lead.manage','lead.convert','tender.read'],
  // §4: owns the tender itself including submission and EMD/BG tracking.
  // Deliberately without tender.override — the checklist gates this role's own
  // work, so it must not hold the key to bypassing it.
  BID_TENDER_MANAGER: [
    'client.read','lead.read',
    'tender.read','tender.manage','tender.submit','tender.award','tender.convert',
    'instrument.read','instrument.manage',
  ],
  // §4: reads across all domains including tender/financial, never mutates.
  AUDITOR: [...READ_ONLY],
  // Sees the commercial context of their projects; does not run the pipeline.
  PROJECT_MANAGER: ['client.read','tender.read','instrument.read'],
  TEAM_LEAD: [],
  EMPLOYEE: [],
  // §4.1: the Viewer cannot see tender financials at all.
  CLIENT_VIEWER: [],
  GOVT_OBSERVER: [],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: ['client.read'],
};

/* ------------------------------------------------------------------ schemas */

const text = z.string().trim().min(1).max(255);
const uuid = z.string().uuid();
const money = z.union([z.string(), z.number().finite()]).transform(String)
  .refine(v => /^\d{1,16}(\.\d{1,2})?$/.test(v), 'Use a positive amount with up to two decimals');
const optionalText = (max = 2000) => z.string().trim().max(max).optional();

export const CLIENT_TYPES = ['GOVERNMENT','PRIVATE'] as const;

/**
 * The client's own fields, before the code is derived.
 *
 * Exported separately because a transform produces a ZodEffects, and
 * ZodEffects has no `.partial()` — which the PATCH route needs.
 */
export const clientBaseSchema = z.object({
  // Derived from the name when omitted. A person adding a client from the
  // project form should not have to invent a key for it, and asking them to
  // is how the same organisation ends up in the master twice.
  code: z.string().trim().max(50).optional(),
  name: text,
  client_type: z.enum(CLIENT_TYPES),
  category: optionalText(100),
  state: optionalText(100), district: optionalText(100),
  mandal: optionalText(100), village: optionalText(100),
  address_line: optionalText(), pincode: optionalText(12),
  website: optionalText(255),
  // Format-checked, not merely length-checked: a malformed GSTIN silently
  // breaks the duplicate-detection index it participates in.
  // Validated against the GSTN check digit and state code, not merely the
  // shape: a transposed character passes a regex and then travels onto every
  // invoice raised for this party.
  gstin: z.string().trim().toUpperCase().refine(isValidGstin,
    'That GSTIN fails its check digit or names an unknown state').optional(),
  pan: z.string().trim().toUpperCase().refine(isValidPan,
    'That PAN is malformed or names an unknown holder type').optional(),
  udyam_number: z.string().trim().toUpperCase().refine(isValidUdyam,
    'Enter a Udyam number in the form UDYAM-XX-00-0000000').optional(),
  msme_category: z.enum(['MICRO','SMALL','MEDIUM']).optional(),
  // MSMED Act s.15 sets 45 days where an agreement fixes a period, 15 without.
  has_written_agreement: z.boolean().default(true),
  credit_limit: money.optional(),
  payment_terms: optionalText(100),
  notes: optionalText(),
});

/**
 * POST /api/v1/clients — the code is derived from the name when absent.
 *
 * A person adding a client from the project form should not have to invent a
 * key for it, and asking them to is how the same organisation lands in the
 * master twice under two spellings.
 */
export const clientSchema = clientBaseSchema.transform((v) => ({
  ...v,
  code: (v.code?.trim() ? v.code : v.name)
    .trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50),
}));

export const contactBaseSchema = z.object({
  client_id: uuid.nullable().optional(),
  name: text,
  designation: optionalText(150),
  department: optionalText(150),
  phone: z.string().trim().regex(/^[0-9+][0-9 -]{6,19}$/, 'Enter a valid phone number').optional(),
  alternate_phone: z.string().trim().regex(/^[0-9+][0-9 -]{6,19}$/, 'Enter a valid phone number').optional(),
  email: z.string().trim().email().max(255).optional(),
  contact_type: z.enum(['PRIMARY','ADDITIONAL']).default('ADDITIONAL'),
  address_line: optionalText(),
  do_not_contact: z.boolean().default(false),
  notes: optionalText(),
});

/** Refined form for create; PATCH uses contactBaseSchema.partial(). */
export const contactSchema = contactBaseSchema.refine(v => v.phone || v.email, {
  message: 'Give at least a phone number or an email address',
  path: ['phone'],
});

export const LEAD_STAGES = ['NEW','CONTACTED','QUALIFIED','TENDER_IDENTIFIED','CONVERTED','LOST','DISQUALIFIED'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/**
 * §7.2 stage machine. CONVERTED is reachable only through the conversion
 * endpoint (§37.2), never by a plain stage edit — otherwise a lead could be
 * marked converted with no destination record and no lineage.
 */
export const LEAD_STAGE_TRANSITIONS: Record<LeadStage, LeadStage[]> = {
  NEW: ['CONTACTED','DISQUALIFIED','LOST'],
  CONTACTED: ['QUALIFIED','DISQUALIFIED','LOST'],
  QUALIFIED: ['TENDER_IDENTIFIED','LOST','DISQUALIFIED'],
  TENDER_IDENTIFIED: ['LOST','DISQUALIFIED'],
  CONVERTED: [],
  LOST: [],
  DISQUALIFIED: [],
};

export const leadSchema = z.object({
  lead_no: text.max(50),
  source: z.enum(['REFERRAL','PORTAL_WATCH','COLD_OUTREACH','EXISTING_CLIENT','OTHER']),
  organization_name: text,
  client_id: uuid.nullable().optional(),
  contact_id: uuid.nullable().optional(),
  lead_type: z.enum(CLIENT_TYPES),
  // What the work is, captured at the first contact rather than when a project
  // finally exists. It decides who bids it and which past jobs are comparable,
  // and carrying it through the conversion stops the same job being filed
  // under three categories at three stages of its life.
  project_type_id: uuid.nullable().optional(),
  project_category_id: uuid.nullable().optional(),
  estimated_value: money.optional(),
  owner_id: uuid.nullable().optional(),
  next_follow_up_date: dateStringSchema.optional(),
  notes: optionalText(),
});

export const leadStageSchema = z.object({
  stage: z.enum(LEAD_STAGES),
  lost_reason: optionalText(),
}).refine(v => !['LOST','DISQUALIFIED'].includes(v.stage) || Boolean(v.lost_reason), {
  message: 'Record why the lead was lost or disqualified',
  path: ['lost_reason'],
});

export const opportunitySchema = z.object({
  lead_id: uuid,
  probability_pct: z.coerce.number().int().min(0).max(100).optional(),
  expected_value: money,
  expected_close_date: dateStringSchema,
});

export const interactionSchema = z.object({
  lead_id: uuid.nullable().optional(),
  opportunity_id: uuid.nullable().optional(),
  client_id: uuid.nullable().optional(),
  contact_id: uuid.nullable().optional(),
  interaction_type: z.enum(['CALL','MEETING','EMAIL','SITE_VISIT','OTHER']),
  occurred_at: z.string().datetime({ offset: true }),
  summary: z.string().trim().min(1).max(4000),
}).refine(v => v.lead_id || v.opportunity_id || v.client_id, {
  message: 'Attach the interaction to a lead, opportunity or client',
  path: ['lead_id'],
});

export const TENDER_STATUSES = ['DRAFT','PUBLISHED','IN_PROGRESS','SUBMITTED','UNDER_EVALUATION',
  'CLARIFICATION_REQUIRED','SELECTED','REJECTED','AWARDED','CANCELLED'] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

/** §8.2 default status machine. CANCELLED is reachable from any live state. */
export const TENDER_STATUS_TRANSITIONS: Record<TenderStatus, TenderStatus[]> = {
  DRAFT: ['PUBLISHED','CANCELLED'],
  PUBLISHED: ['IN_PROGRESS','CANCELLED'],
  IN_PROGRESS: ['SUBMITTED','CANCELLED'],
  SUBMITTED: ['UNDER_EVALUATION','CLARIFICATION_REQUIRED','REJECTED','CANCELLED'],
  UNDER_EVALUATION: ['SELECTED','REJECTED','CLARIFICATION_REQUIRED','CANCELLED'],
  CLARIFICATION_REQUIRED: ['UNDER_EVALUATION','SUBMITTED','REJECTED','CANCELLED'],
  SELECTED: ['AWARDED','REJECTED','CANCELLED'],
  REJECTED: [],
  AWARDED: [],
  CANCELLED: [],
};

export const tenderBaseSchema = z.object({
  tender_no: text.max(50),
  tender_type: z.enum(['OPEN','LIMITED','SINGLE','EOI','RFP']),
  // `category` is the tendering authority's own free-text work category, as
  // printed on the notice. project_category_id is ours, from the master, and
  // the two are deliberately separate: theirs is evidence, ours is the
  // classification every report groups by.
  category: optionalText(150),
  project_type_id: uuid.nullable().optional(),
  project_category_id: uuid.nullable().optional(),
  client_id: uuid.nullable().optional(),
  opportunity_id: uuid.nullable().optional(),
  state: optionalText(100), district: optionalText(100), location: optionalText(255),
  department: optionalText(255), authority: optionalText(255),
  reference_number: optionalText(100), package_lot_no: optionalText(50),
  estimated_value: money.optional(),
  bid_value: money.optional(),
  start_date: dateStringSchema.optional(),
  closing_date: dateStringSchema.optional(),
  opening_date: dateStringSchema.optional(),
  submission_date: dateStringSchema.optional(),
  bid_validity_days: z.coerce.number().int().min(0).max(3650).optional(),
  portal: optionalText(150),
  portal_url: z.string().trim().url().max(2000).optional(),
  dsc_used_by: uuid.nullable().optional(),
  // §8: item-rate prices a BOQ line by line, percentage-rate quotes a single
  // figure against the estimate (the CPWD/PWD norm), lump-sum quotes one price.
  bid_type: z.enum(['ITEM_RATE','PERCENTAGE_RATE','LUMP_SUM']).default('ITEM_RATE'),
  /** Signed: negative is below the estimate, which is the common winning case. */
  quoted_percentage: z.coerce.number().min(-99.999).max(200).optional(),
  /** Estimated Contract Value — what a percentage bid is applied to. */
  ecv: money.optional(),
  cover_system: z.enum(['SINGLE','TWO_COVER','THREE_COVER']).default('SINGLE'),
  tender_fee: money.optional(),
  emd_amount: money.optional(),
  emd_exempt: z.boolean().default(false),
  emd_exemption_basis: z.enum(['MSME','NSIC','STARTUP','OTHER']).optional(),
  emd_exemption_ref: optionalText(50),
  pre_bid_meeting_at: z.string().datetime({ offset: true }).optional(),
  clarification_due_at: dateStringSchema.optional(),
  jv_flag: z.boolean().default(false),
  jv_partners: z.array(z.object({ name: text, scope_pct: z.coerce.number().min(0).max(100) })).max(20).default([]),
  notes: optionalText(),
});

/** Refined form for create; PATCH uses tenderBaseSchema.partial(). */
export const tenderSchema = tenderBaseSchema
  .refine(v => !v.closing_date || !v.start_date || v.closing_date >= v.start_date, {
    message: 'Closing date cannot precede the start date',
    path: ['closing_date'],
  })
  .refine(v => !v.jv_flag || v.jv_partners.length > 0, {
    message: 'A joint venture needs at least one partner firm',
    path: ['jv_partners'],
  })
  // A percentage quote is meaningless without the estimate it applies to.
  .refine(v => v.bid_type !== 'PERCENTAGE_RATE' || v.quoted_percentage === undefined || v.ecv !== undefined, {
    message: 'A percentage-rate bid needs the estimated contract value it is quoted against',
    path: ['ecv'],
  })
  // The authority asks for the registration number, not the claim.
  .refine(v => !v.emd_exempt || (v.emd_exemption_basis && v.emd_exemption_ref), {
    message: 'An EMD exemption must name its basis and the registration number that proves it',
    path: ['emd_exemption_ref'],
  })
  // A JV's partner shares must account for the whole scope.
  .refine(v => !v.jv_flag || Math.abs(v.jv_partners.reduce((t, p) => t + Number(p.scope_pct), 0) - 100) < 0.01, {
    message: 'Joint-venture partner shares must total 100%',
    path: ['jv_partners'],
  });

/**
 * What a bid is actually worth in rupees.
 *
 * A percentage-rate bid stores a signed percentage against the estimate rather
 * than an amount, so every comparison, ranking and profitability figure has to
 * resolve it first. Returning null rather than guessing keeps an unpriced
 * tender out of a total instead of silently contributing zero.
 */
export function effectiveBidValue(t: {
  bid_type?: string | null;
  quoted_percentage?: number | string | null;
  ecv?: number | string | null;
  bid_value?: number | string | null;
}): number | null {
  if (t.bid_type === 'PERCENTAGE_RATE') {
    const pct = Number(t.quoted_percentage), ecv = Number(t.ecv);
    if (!Number.isFinite(pct) || !Number.isFinite(ecv)) return null;
    return Math.round(ecv * (1 + pct / 100) * 100) / 100;
  }
  const value = Number(t.bid_value);
  return Number.isFinite(value) ? value : null;
}

/** A GST registration for a party — one per state it operates in (§6.5). */
export const gstRegistrationSchema = z.object({
  party_type: z.enum(['CLIENT','VENDOR']),
  party_id: uuid,
  gstin: z.string().trim().toUpperCase().refine(isValidGstin,
    'That GSTIN fails its check digit or names an unknown state'),
  registration_type: z.enum(['REGULAR','COMPOSITION','UNREGISTERED','SEZ','SEZ_DEVELOPER','UIN','NON_RESIDENT']).default('REGULAR'),
  address_line: optionalText(),
  is_primary: z.boolean().default(false),
  effective_from: dateStringSchema.optional(),
});

export const tenderStatusSchema = z.object({
  status: z.enum(TENDER_STATUSES),
  reason: optionalText(),
  /** §8.6: pushing past an incomplete required checklist needs a stated reason. */
  override_reason: optionalText(),
});

export const corrigendumSchema = z.object({
  corrigendum_no: text.max(50),
  date_issued: dateStringSchema,
  summary: z.string().trim().min(1).max(4000),
  fields_affected: z.array(z.string().trim().max(60)).max(20).default([]),
  /** §8.5: the new values to apply; prior values are captured server-side. */
  changes: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
});

export const eligibilityItemSchema = z.object({
  requirement_name: text,
  is_required: z.boolean().default(true),
  item_status: z.enum(['NOT_STARTED','IN_PROGRESS','READY','SUBMITTED']).default('NOT_STARTED'),
  document_id: uuid.nullable().optional(),
  notes: optionalText(),
});

export const competitorBidSchema = z.object({
  competitor_name: text,
  quoted_amount: money.optional(),
  rank: z.coerce.number().int().min(1).max(999).optional(),
  notes: optionalText(),
});

export const instrumentSchema = z.object({
  instrument_type: z.enum(['EMD','BID_SECURITY_BG','PERFORMANCE_BG','ADVANCE_BG','RETENTION_BG']),
  issuing_bank: text,
  instrument_number: text.max(100),
  amount: money,
  issue_date: dateStringSchema,
  expiry_date: dateStringSchema,
  tender_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  document_id: uuid.nullable().optional(),
  notes: optionalText(),
}).refine(v => v.expiry_date >= v.issue_date, {
  message: 'Expiry cannot precede the issue date',
  path: ['expiry_date'],
}).refine(v => v.tender_id || v.project_id, {
  message: 'Attach the instrument to a tender or a project',
  path: ['tender_id'],
});

export const instrumentStatusSchema = z.object({
  instrument_status: z.enum(['ACTIVE','RELEASED','CLAIMED','EXPIRED','RENEWED']),
  reason: optionalText(),
});

export const proposalSchema = z.object({
  proposal_no: text.max(50),
  client_id: uuid,
  contact_id: uuid.nullable().optional(),
  opportunity_id: uuid.nullable().optional(),
  rfq_reference: optionalText(100),
  proposal_date: dateStringSchema,
  quotation_no: optionalText(50),
  quotation_date: dateStringSchema.optional(),
  contract_value: money.optional(),
  negotiation_status: optionalText(30),
  competing_quotes: z.array(z.object({ vendor: text, amount: money })).max(20).default([]),
  recurring_amc_flag: z.boolean().default(false),
  notes: optionalText(),
});

/** §8.7 / §8.8 conversion into a project. */
export const conversionSchema = z.object({
  workspace_id: uuid,
  code: text.max(50),
  name: text,
  project_manager_id: uuid.nullable().optional(),
  contract_value: money.optional(),
  work_order_number: optionalText(100),
  planned_start_date: dateStringSchema.optional(),
  planned_end_date: dateStringSchema.optional(),
  // Override what the tender carried, for the case where the classification
  // was provisional at bid time and is only settled on award. Left out, the
  // source's own values travel across.
  project_type_id: uuid.nullable().optional(),
  project_category_id: uuid.nullable().optional(),
  /** Link an existing draft project instead of creating one (§37.2). */
  existing_project_id: uuid.nullable().optional(),
}).refine(v => !v.planned_end_date || !v.planned_start_date || v.planned_end_date >= v.planned_start_date, {
  message: 'End date cannot precede the start date',
  path: ['planned_end_date'],
});
