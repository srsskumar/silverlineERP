import { z } from 'zod';
import type { RoleCode } from './rbac.js';

/**
 * Document governance (§46).
 *
 * Documents already exist all over Silverline — employee records, task
 * evidence, payslips, tender papers. Each lives in its own table with its own
 * schema, and nothing knows about documents as a class. That is fine until
 * somebody asks what is about to expire, which in Indian construction is
 * sometimes the same question as whether work can continue tomorrow.
 *
 * Every state here is derived rather than stored, for the reason §45 gives
 * about settlement positions: a stored status is a status that is wrong at
 * midnight.
 */

/* ------------------------------------------------------------------ state */

export const DOCUMENT_STATES = [
  'VALID', 'EXPIRING', 'EXPIRED', 'SUPERSEDED', 'NO_EXPIRY',
] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const DOCUMENT_OWNERS = [
  'employee', 'project', 'client', 'vendor', 'asset', 'tender', 'organization',
] as const;
export type DocumentOwner = (typeof DOCUMENT_OWNERS)[number];

/** Whole days from `from` to `to`, negative once `to` is in the past. */
export function daysUntil(to: string, from: string): number {
  const a = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  const b = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  return Math.round((a - b) / 86_400_000);
}

export interface DocumentLike {
  expiresOn?: string | null;
  supersededById?: string | null;
  /** Days of warning before expiry. A property of the type, not the document. */
  noticeDays?: number | null;
}

/**
 * What state a document is in, as at a date.
 *
 * Supersession is checked before expiry: a licence that was renewed last month
 * is not an expired licence, it is an old copy of a current one. Reporting it
 * as expired sends somebody to renew a document that has already been renewed,
 * and after that happens twice nobody reads the alerts.
 */
export function documentState(doc: DocumentLike, asOf: string): DocumentState {
  if (doc.supersededById) return 'SUPERSEDED';
  if (!doc.expiresOn) return 'NO_EXPIRY';
  const days = daysUntil(doc.expiresOn, asOf);
  if (days < 0) return 'EXPIRED';
  // The notice window defaults to thirty days, but a type that takes six weeks
  // to renew sets its own. A single global window is what makes an expiry
  // report either constant noise or a surprise.
  if (days <= (doc.noticeDays ?? 30)) return 'EXPIRING';
  return 'VALID';
}

/** Expires today: still in force, and the last day it is. */
export function isInForce(state: DocumentState): boolean {
  return state === 'VALID' || state === 'EXPIRING' || state === 'NO_EXPIRY';
}

/* ------------------------------------------------------------------ types */

export interface DocumentTypeSeed {
  code: string;
  label: string;
  category: 'STATUTORY' | 'INSURANCE' | 'EQUIPMENT' | 'PEOPLE' | 'COMMERCIAL';
  /** Owners this type can attach to. Empty means any. */
  owners: DocumentOwner[];
  /** Days of warning. Set from how long the renewal actually takes. */
  noticeDays: number;
  /** A row of this type without an expiry date is refused. */
  expiryRequired: boolean;
  /** Its lapse stops work, rather than merely being untidy. */
  blocksOperations: boolean;
  /** Years the document must be kept after it expires or is issued. */
  retentionYears: number;
  /** Visible only with document.confidential. */
  confidential: boolean;
  /** The statutory or contractual basis, shown in the UI. */
  basis?: string;
}

/**
 * The seeded types.
 *
 * Seeded rather than left empty because the first user types "Labour Licence",
 * the second types "labour license", and from then on the register cannot
 * answer the question it exists for. Notice windows come from how long the
 * renewal actually takes in practice, not from a round number.
 */
export const DOCUMENT_TYPE_SEEDS: DocumentTypeSeed[] = [
  /* --- statutory and licensing ------------------------------------- */
  {
    code: 'LABOUR_LICENCE', label: 'Labour licence', category: 'STATUTORY',
    owners: ['organization', 'project'], noticeDays: 60, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: false,
    basis: 'Contract Labour (Regulation and Abolition) Act 1970, s.12',
  },
  {
    code: 'BOCW_REGISTRATION', label: 'BOCW registration', category: 'STATUTORY',
    owners: ['organization', 'project'], noticeDays: 60, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: false,
    basis: 'Building and Other Construction Workers Act 1996, s.7',
  },
  {
    code: 'GST_REGISTRATION', label: 'GST registration', category: 'STATUTORY',
    owners: ['organization', 'vendor', 'client'], noticeDays: 30, expiryRequired: false,
    blocksOperations: true, retentionYears: 8, confidential: false,
    basis: 'CGST Act 2017, s.25',
  },
  {
    code: 'PAN', label: 'PAN', category: 'STATUTORY',
    owners: ['organization', 'employee', 'vendor', 'client'], noticeDays: 30,
    expiryRequired: false, blocksOperations: false, retentionYears: 8,
    confidential: true, basis: 'Income Tax Act 1961, s.139A',
  },
  {
    code: 'TAN', label: 'TAN', category: 'STATUTORY',
    owners: ['organization'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 8, confidential: false,
    basis: 'Income Tax Act 1961, s.203A',
  },
  {
    code: 'UDYAM', label: 'Udyam registration', category: 'STATUTORY',
    owners: ['organization', 'vendor'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 8, confidential: false,
    basis: 'MSMED Act 2006 — governs the payment period owed to this supplier',
  },
  {
    code: 'EPF_CODE', label: 'EPF code', category: 'STATUTORY',
    owners: ['organization'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 8, confidential: false,
    basis: 'Employees Provident Funds Act 1952',
  },
  {
    code: 'ESIC_CODE', label: 'ESIC code', category: 'STATUTORY',
    owners: ['organization'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 8, confidential: false,
    basis: 'Employees State Insurance Act 1948',
  },
  {
    code: 'SHOPS_ESTABLISHMENT', label: 'Shops and establishments', category: 'STATUTORY',
    owners: ['organization'], noticeDays: 45, expiryRequired: true,
    blocksOperations: false, retentionYears: 3, confidential: false,
  },
  {
    code: 'PROFESSIONAL_TAX', label: 'Professional tax registration', category: 'STATUTORY',
    owners: ['organization'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 8, confidential: false,
  },

  /* --- insurance ---------------------------------------------------- */
  {
    code: 'CAR_POLICY', label: "Contractor's all-risk policy", category: 'INSURANCE',
    owners: ['project', 'organization'], noticeDays: 45, expiryRequired: true,
    blocksOperations: true, retentionYears: 8, confidential: false,
    basis: 'Usually a condition of the contract as well as prudence',
  },
  {
    code: 'WC_POLICY', label: "Workmen's compensation policy", category: 'INSURANCE',
    owners: ['project', 'organization'], noticeDays: 45, expiryRequired: true,
    blocksOperations: true, retentionYears: 8, confidential: false,
    basis: "Employee's Compensation Act 1923 — liability is statutory and uninsurable after the fact",
  },
  {
    code: 'THIRD_PARTY_LIABILITY', label: 'Third-party liability policy', category: 'INSURANCE',
    owners: ['project', 'organization'], noticeDays: 45, expiryRequired: true,
    blocksOperations: false, retentionYears: 8, confidential: false,
  },
  {
    code: 'VEHICLE_INSURANCE', label: 'Vehicle insurance', category: 'INSURANCE',
    owners: ['asset'], noticeDays: 30, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: false,
    basis: 'Motor Vehicles Act 1988, s.146 — driving uninsured is an offence',
  },

  /* --- equipment and vehicle ---------------------------------------- */
  {
    code: 'LIFTING_TACKLE_CERTIFICATE', label: 'Lifting tackle test certificate',
    category: 'EQUIPMENT', owners: ['asset'], noticeDays: 30, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: false,
    basis: 'BOCW Central Rules 1998 — the equipment must be withdrawn from service on lapse',
  },
  {
    code: 'FITNESS_CERTIFICATE', label: 'Vehicle fitness certificate', category: 'EQUIPMENT',
    owners: ['asset'], noticeDays: 30, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: false,
    basis: 'Motor Vehicles Act 1988, s.56',
  },
  {
    code: 'PERMIT', label: 'Vehicle permit', category: 'EQUIPMENT',
    owners: ['asset'], noticeDays: 30, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: false,
  },
  {
    code: 'PUC', label: 'Pollution under control certificate', category: 'EQUIPMENT',
    owners: ['asset'], noticeDays: 7, expiryRequired: true,
    blocksOperations: false, retentionYears: 1, confidential: false,
    // Renewed in an afternoon, so sixty days of warning would be pure noise.
  },

  /* --- people ------------------------------------------------------- */
  {
    code: 'DRIVING_LICENCE', label: 'Driving licence', category: 'PEOPLE',
    owners: ['employee'], noticeDays: 45, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: true,
  },
  {
    code: 'MEDICAL_FITNESS', label: 'Medical fitness certificate', category: 'PEOPLE',
    owners: ['employee'], noticeDays: 30, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: true,
    basis: 'BOCW Central Rules 1998 — required before deployment on site',
  },
  {
    code: 'SAFETY_TRAINING', label: 'Safety training card', category: 'PEOPLE',
    owners: ['employee'], noticeDays: 30, expiryRequired: true,
    blocksOperations: true, retentionYears: 3, confidential: false,
  },
  {
    code: 'EMPLOYMENT_CONTRACT', label: 'Employment contract', category: 'PEOPLE',
    owners: ['employee'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 3, confidential: true,
  },
  {
    code: 'EDUCATIONAL_CERTIFICATE', label: 'Educational certificate', category: 'PEOPLE',
    owners: ['employee'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 3, confidential: true,
  },

  /* --- commercial --------------------------------------------------- */
  {
    code: 'BANK_GUARANTEE', label: 'Bank guarantee', category: 'COMMERCIAL',
    owners: ['project', 'tender', 'client'], noticeDays: 60, expiryRequired: true,
    blocksOperations: false, retentionYears: 8, confidential: false,
    basis: 'Expiry leaves the client unsecured; a claim period usually runs past it',
  },
  {
    code: 'EMD', label: 'Earnest money deposit', category: 'COMMERCIAL',
    owners: ['tender'], noticeDays: 30, expiryRequired: true,
    blocksOperations: false, retentionYears: 3, confidential: false,
  },
  {
    code: 'WORK_ORDER', label: 'Work order', category: 'COMMERCIAL',
    owners: ['project'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 8, confidential: false,
  },
  {
    code: 'AGREEMENT', label: 'Agreement', category: 'COMMERCIAL',
    owners: ['project', 'client', 'vendor'], noticeDays: 60, expiryRequired: false,
    blocksOperations: false, retentionYears: 8, confidential: false,
  },
  {
    code: 'DRAWING', label: 'Drawing', category: 'COMMERCIAL',
    owners: ['project'], noticeDays: 30, expiryRequired: false,
    blocksOperations: false, retentionYears: 8, confidential: false,
  },
  {
    code: 'BID_DOCUMENT', label: 'Bid document', category: 'COMMERCIAL',
    owners: ['tender'], noticeDays: 15, expiryRequired: false,
    blocksOperations: false, retentionYears: 3, confidential: false,
  },
];

export const DOCUMENT_TYPE_CODES = DOCUMENT_TYPE_SEEDS.map(s => s.code);

/** Whether a type may attach to an owner. Empty `owners` means anything. */
export function typeAllowsOwner(seed: Pick<DocumentTypeSeed, 'owners'>, owner: DocumentOwner): boolean {
  return seed.owners.length === 0 || seed.owners.includes(owner);
}

/* --------------------------------------------------------------- register */

/**
 * What a register listing reports.
 *
 * `blocking` is counted apart from `expired` deliberately. The difference
 * between a stale copy of a director's PAN and a lapsed labour licence is the
 * difference between untidy and unlawful, and a single "12 expired documents"
 * figure flattens it.
 */
export interface RegisterSummary {
  total: number;
  valid: number;
  expiring: number;
  expired: number;
  superseded: number;
  noExpiry: number;
  /** In force but inside the notice window, and their lapse stops work. */
  blockingSoon: number;
  /** Already expired, and their lapse stops work. */
  blocking: number;
}

export interface RegisterItem {
  expiresOn?: string | null;
  supersededById?: string | null;
  noticeDays?: number | null;
  blocksOperations?: boolean;
}

export function summarise(items: RegisterItem[], asOf: string): RegisterSummary {
  const s: RegisterSummary = {
    total: items.length, valid: 0, expiring: 0, expired: 0,
    superseded: 0, noExpiry: 0, blockingSoon: 0, blocking: 0,
  };
  for (const item of items) {
    const state = documentState(item, asOf);
    if (state === 'VALID') s.valid += 1;
    if (state === 'EXPIRING') s.expiring += 1;
    if (state === 'EXPIRED') s.expired += 1;
    if (state === 'SUPERSEDED') s.superseded += 1;
    if (state === 'NO_EXPIRY') s.noExpiry += 1;
    if (item.blocksOperations) {
      if (state === 'EXPIRED') s.blocking += 1;
      if (state === 'EXPIRING') s.blockingSoon += 1;
    }
  }
  return s;
}

/**
 * What needs renewing, most urgent first.
 *
 * Ordered by how close to lapsing a document is, with anything that stops work
 * ahead of anything that does not at the same distance. Superseded rows are
 * dropped: chasing the renewal of a document that has already been renewed is
 * exactly the noise that trains people to ignore the list.
 */
export function renewalQueue<T extends RegisterItem>(
  items: T[], asOf: string, withinDays = 60,
): Array<T & { state: DocumentState; daysRemaining: number }> {
  return items
    .filter(i => !i.supersededById && i.expiresOn)
    .map(i => ({
      ...i,
      state: documentState(i, asOf),
      daysRemaining: daysUntil(i.expiresOn!, asOf),
    }))
    .filter(i => i.daysRemaining <= withinDays)
    .sort((a, b) => {
      if (a.daysRemaining !== b.daysRemaining) return a.daysRemaining - b.daysRemaining;
      const ao = a.blocksOperations ? 0 : 1, bo = b.blocksOperations ? 0 : 1;
      return ao - bo;
    });
}

/* ------------------------------------------------------------- retention */

export interface RetentionCheck {
  deletable: boolean;
  reason?: string;
  /** The date routine deletion becomes permissible. */
  retainUntil?: string;
}

/**
 * Whether a document may be deleted.
 *
 * Retention runs from expiry where there is one and from issue otherwise: a
 * licence valid until 2027 must be kept for its retention period after 2027,
 * not after the day it was issued.
 *
 * A legal hold overrides everything. A document under audit, dispute or
 * arbitration survives any routine clean-up regardless of its age, and the
 * refusal says so rather than reporting a date.
 */
export function canDelete(args: {
  issuedOn?: string | null;
  expiresOn?: string | null;
  retentionYears: number;
  legalHold?: boolean;
  asOf: string;
}): RetentionCheck {
  if (args.legalHold) {
    return {
      deletable: false,
      reason: 'Under legal hold. It cannot be deleted until the hold is released, whatever its age.',
    };
  }
  const anchor = args.expiresOn ?? args.issuedOn;
  if (!anchor) {
    return {
      deletable: false,
      reason: 'Neither an issue date nor an expiry date is recorded, so the retention period cannot be worked out.',
    };
  }
  const until = new Date(Date.UTC(
    +anchor.slice(0, 4) + args.retentionYears,
    +anchor.slice(5, 7) - 1,
    +anchor.slice(8, 10),
  )).toISOString().slice(0, 10);
  if (args.asOf < until) {
    return {
      deletable: false,
      retainUntil: until,
      reason: `Statutory retention runs to ${until}.`,
    };
  }
  return { deletable: true, retainUntil: until };
}

/* --------------------------------------------------------------- schemas */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const documentBaseSchema = z.object({
  type_code: z.string().min(1).max(64),
  owner_type: z.enum(DOCUMENT_OWNERS),
  owner_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(255),
  reference_number: z.string().max(128).nullable().optional(),
  issuing_authority: z.string().max(255).nullable().optional(),
  issued_on: isoDate.nullable().optional(),
  valid_from: isoDate.nullable().optional(),
  expires_on: isoDate.nullable().optional(),
  revision: z.string().max(32).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  source_type: z.string().max(64).nullable().optional(),
  source_id: z.string().uuid().nullable().optional(),
});

export const documentCreateSchema = documentBaseSchema.refine(
  d => !d.expires_on || !d.valid_from || d.expires_on >= d.valid_from,
  { message: 'A document cannot expire before it takes effect', path: ['expires_on'] },
);

export const documentPatchSchema = documentBaseSchema.partial();

/**
 * The dates an amendment may not change (§46.3.4, §46.6.1).
 *
 * Retention is counted from them. An edit that moves an expiry ten years back
 * makes a document deletable today, and one that clears it turns a labour
 * licence into a document that "never expires". A new date means a new
 * certificate, which is a renewal: the old one stays on the register.
 */
export const DOCUMENT_IMMUTABLE_DATES = ['issued_on', 'valid_from', 'expires_on'] as const;

/**
 * Renewing a document: a new row that supersedes the old one.
 *
 * Not an edit of the expiry date. The previous certificate existed, an
 * inspector may ask for it, and overwriting the date destroys the only record
 * that the organisation was covered last year.
 */
export const documentRenewSchema = z.object({
  // Optional here, required by the route when the type demands an expiry. A
  // drawing or an agreement is revised without ever expiring, and insisting
  // on a date made the only honest answer -- none -- impossible to record.
  expires_on: isoDate.nullable().optional(),
  issued_on: isoDate.nullable().optional(),
  valid_from: isoDate.nullable().optional(),
  reference_number: z.string().max(128).nullable().optional(),
  revision: z.string().max(32).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const legalHoldSchema = z.object({
  legal_hold: z.boolean(),
  reason: z.string().min(3).max(500).nullable().optional(),
}).refine(v => !v.legal_hold || (v.reason ?? '').trim().length >= 3, {
  message: 'A hold needs a reason — an unexplained hold is indistinguishable from an oversight later',
  path: ['reason'],
});

/* ----------------------------------------------------------- permissions */

export const DOCUMENT_PERMISSIONS = [
  'document.read', 'document.manage', 'document.confidential',
  'document.delete', 'document.legalhold',
  // Releasing is its own permission (§46.6.2). Lifting a hold ends the
  // protection the hold exists to give, so who may do it is a separate
  // decision from who may place one.
  'document.legalhold.release',
] as const;

export const DOCUMENT_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...DOCUMENT_PERMISSIONS],
  ADMIN: [...DOCUMENT_PERMISSIONS],
  // Holds the statutory file in practice, and is who chases a renewal.
  HR_MANAGER: ['document.read', 'document.manage', 'document.confidential'],
  PROJECT_MANAGER: ['document.read', 'document.manage'],
  BID_TENDER_MANAGER: ['document.read', 'document.manage'],
  GOVT_OBSERVER: [],
  INVENTORY_MANAGER: ['document.read', 'document.manage'],
  PAYROLL_OFFICER: ['document.read', 'document.confidential'],
  // Reads everything including the confidential types, and places a hold.
  // Cannot delete: an auditor who can destroy evidence is not a control.
  // Cannot release a hold either (owner decision 2026-09-24 #4): placing one
  // protects a document, releasing it is the step that makes the document
  // deletable again, and that is not an auditor's call to make alone.
  AUDITOR: ['document.read', 'document.confidential', 'document.legalhold'],
  TEAM_LEAD: ['document.read'],
  SALES_BD_EXECUTIVE: ['document.read'],
  // Sees the register for their own employer's documents through the employee
  // screens, not through this one.
  EMPLOYEE: [],
  CLIENT_VIEWER: [],
};
