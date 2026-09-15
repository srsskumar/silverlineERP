/**
 * Presentation for the document register (§46).
 *
 * The register's whole job is to answer "what is about to expire, and what
 * stops if it does". Everything here serves that: how a state reads, how
 * urgent a deadline looks, and how to say plainly what a lapse would cost.
 */

export const DOCUMENT_STATES = [
  'VALID', 'EXPIRING', 'EXPIRED', 'SUPERSEDED', 'NO_EXPIRY',
] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const STATE_LABELS: Record<DocumentState, string> = {
  VALID: 'In force',
  EXPIRING: 'Expiring',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded',
  NO_EXPIRY: 'No expiry',
};

/**
 * How a state reads at a glance.
 *
 * SUPERSEDED is neutral rather than a warning: it means the document was
 * renewed, which is the good outcome. Colouring it like a problem is what
 * trains people to stop reading the colours.
 */
export function stateTone(state: DocumentState): 'success' | 'warning' | 'danger' | 'neutral' {
  if (state === 'EXPIRED') return 'danger';
  if (state === 'EXPIRING') return 'warning';
  if (state === 'VALID') return 'success';
  return 'neutral';
}

export const OWNER_LABELS: Record<string, string> = {
  employee: 'Employee',
  project: 'Project',
  client: 'Client',
  vendor: 'Supplier',
  asset: 'Asset',
  tender: 'Tender',
  organization: 'The company',
};

export const CATEGORY_LABELS: Record<string, string> = {
  STATUTORY: 'Statutory and licensing',
  INSURANCE: 'Insurance',
  EQUIPMENT: 'Equipment and vehicles',
  PEOPLE: 'People',
  COMMERCIAL: 'Commercial',
};

/**
 * A deadline in the words somebody would actually use.
 *
 * "-14" is a number to decode; "expired 14 days ago" is a fact. The register
 * is read under time pressure and the reader should not have to work out the
 * sign.
 */
export function deadlineLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return 'No expiry date';
  if (days < -1) return `Expired ${Math.abs(days)} days ago`;
  if (days === -1) return 'Expired yesterday';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  if (days < 45) return `${days} days left`;
  if (days < 365) return `${Math.round(days / 30)} months left`;
  return `${Math.round(days / 365)} years left`;
}

/**
 * What a lapse actually costs, said plainly.
 *
 * Somebody told their site cannot operate deserves to be told why, and the
 * statutory basis is the difference between an instruction and an explanation.
 */
export function consequence(doc: {
  blocks_operations?: boolean; basis?: string | null; state?: string;
}): string | null {
  if (!doc.blocks_operations) return null;
  const lapse = doc.state === 'EXPIRED'
    ? 'This has lapsed, and work depending on it should stop until it is renewed.'
    : 'Work depending on this stops if it lapses.';
  return doc.basis ? `${lapse} ${doc.basis}.` : lapse;
}

/**
 * The register's headline, as a sentence.
 *
 * A count of expired documents is not the same thing as a count of problems,
 * so the sentence separates them: what is merely untidy, and what is
 * unlawful.
 */
export function registerHeadline(summary: {
  total: number; expired: number; expiring: number; blocking: number; blockingSoon: number;
} | undefined): string {
  if (!summary || summary.total === 0) return 'Nothing is on the register yet.';
  if (summary.blocking > 0) {
    return `${summary.blocking} document${summary.blocking === 1 ? ' has' : 's have'} lapsed that work depends on. `
      + 'Until each is renewed, the activity it covers should not continue.';
  }
  if (summary.blockingSoon > 0) {
    return `${summary.blockingSoon} document${summary.blockingSoon === 1 ? '' : 's'} that work depends on `
      + `${summary.blockingSoon === 1 ? 'is' : 'are'} inside the renewal window.`;
  }
  if (summary.expired > 0) {
    return `${summary.expired} document${summary.expired === 1 ? ' has' : 's have'} expired. `
      + 'None of them stops work, but the register is not clean.';
  }
  if (summary.expiring > 0) {
    return `${summary.expiring} document${summary.expiring === 1 ? '' : 's'} due for renewal. Nothing has lapsed.`;
  }
  return 'Everything on the register is in force.';
}

/** Why a document cannot be deleted, if it cannot. */
export function retentionNote(retention: {
  deletable?: boolean; reason?: string; retainUntil?: string;
} | undefined): string | null {
  if (!retention || retention.deletable) return null;
  return retention.reason ?? 'Cannot be deleted yet.';
}
