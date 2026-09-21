import { z } from 'zod';
import { amountInWords, splitGst, GST_RATES, type GstTreatment } from './india.js';
import type { RoleCode } from './rbac.js';

/**
 * §077 -- what we are supplying, and at what price.
 *
 * A field-work project is measured: a bill of quantities, a surveyor with a
 * tape, and an RA bill for what was actually done. A goods, services or AMC
 * project is not. It is a list agreed in advance -- twelve rovers at this
 * price, a year of maintenance at that one -- and the question the client
 * asks is "what is the total, with GST, in words".
 *
 * Two levels, deliberately:
 *
 *   The catalogue holds what we sell and what we normally charge for it.
 *   A supply line holds what was agreed with THIS client on THIS project,
 *   with its own copy of the price. Changing the standard rate next
 *   quarter must not silently restate a contract signed last quarter, and
 *   the agreed price stays editable on the line, because it is negotiated.
 */

/** Project types that are supplied rather than measured. */
export const SUPPLY_PROJECT_TYPES = ['goods', 'goods_and_services', 'services', 'amc'] as const;

export function isSupplyProject(typeCode: string | null | undefined): boolean {
  return !!typeCode && (SUPPLY_PROJECT_TYPES as readonly string[]).includes(typeCode.toLowerCase());
}

export const CATALOGUE_KINDS = ['GOOD', 'SERVICE', 'AMC'] as const;
export type CatalogueKind = (typeof CATALOGUE_KINDS)[number];

export const SUPPLY_PERMISSIONS = ['catalogue.read', 'catalogue.manage'] as const;

/**
 * The seed resets role_permissions from these maps, so a permission granted
 * only by a migration is wiped the next time the seed runs. That has caught
 * this codebase twice; the map is the durable half.
 *
 * Reading goes with reading a project -- whoever may look at the contract
 * may see what it is for. Setting the standard rates is a commercial
 * decision, and stays with the roles that already make them.
 */
export const SUPPLY_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...SUPPLY_PERMISSIONS],
  ADMIN: [...SUPPLY_PERMISSIONS],
  BID_TENDER_MANAGER: ['catalogue.read', 'catalogue.manage'],
  SALES_BD_EXECUTIVE: ['catalogue.read', 'catalogue.manage'],
  PROJECT_MANAGER: ['catalogue.read'],
  TEAM_LEAD: ['catalogue.read'],
  CLIENT_VIEWER: ['catalogue.read'],
  AUDITOR: ['catalogue.read'],
  EMPLOYEE: [],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: [],
  /* The department is given the survey dashboard and nothing commercial. */
  GOVT_OBSERVER: [],
};

const money = z.number().finite().nonnegative();
/*
 * A rate off this list is almost always a mistake rather than an unusual
 * supply -- the slab is set by law, not by the seller -- so the schema says
 * so rather than letting a typo of 1.8 for 18 through to an invoice.
 */
const gstRate = z.number().refine(
  (r) => (GST_RATES as readonly number[]).includes(r),
  { message: 'Not a GST rate. The slabs are 0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18 and 28 per cent.' },
);

export const catalogueItemSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  kind: z.enum(CATALOGUE_KINDS),
  uom: z.string().trim().min(1).max(20),
  /* HSN for goods, SAC for services. Same field, same eight digits, and the
   * invoice needs it -- so it is captured where the item is defined rather
   * than remembered at billing time. */
  hsn_sac: z.string().trim().regex(/^\d{4,8}$/, 'HSN or SAC is 4 to 8 digits').nullable().optional(),
  standard_rate: money,
  gst_rate: gstRate,
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type CatalogueItemInput = z.infer<typeof catalogueItemSchema>;

export const supplyLineSchema = z.object({
  catalogue_item_id: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1).max(500),
  hsn_sac: z.string().trim().regex(/^\d{4,8}$/).nullable().optional(),
  uom: z.string().trim().min(1).max(20),
  quantity: z.number().finite().positive(),
  /* The agreed price for this contract. Seeded from the catalogue, and
   * editable, because it is negotiated. */
  unit_price: money,
  gst_rate: gstRate,
  /*
   * Whether the agreed price already has GST in it. Both happen: a tender
   * quotes ex-GST, a shopfront quotes inclusive, and getting it the wrong
   * way round misstates the invoice by eighteen per cent.
   */
  price_includes_gst: z.boolean().default(false),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type SupplyLineInput = z.infer<typeof supplyLineSchema>;

export const supplyScheduleSchema = z.object({
  lines: z.array(supplyLineSchema).max(500),
});

export interface SupplyLineLike {
  quantity: number;
  unit_price: number;
  gst_rate: number;
  price_includes_gst?: boolean;
}

export interface LineTotals {
  /** Value GST is charged on. */
  taxable: number;
  gst: number;
  /** What the client pays for this line. */
  gross: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * One line, both ways round.
 *
 * Exclusive is the easy direction. Inclusive has to work backwards out of
 * the gross, and it is rounded once at the end rather than per step: doing
 * it per step is how a twelve-line schedule ends up a rupee off the figure
 * the client added up on their side.
 */
export function lineTotals(line: SupplyLineLike): LineTotals {
  const rate = line.gst_rate / 100;
  if (line.price_includes_gst) {
    const gross = round2(line.quantity * line.unit_price);
    const taxable = round2(gross / (1 + rate));
    return { taxable, gst: round2(gross - taxable), gross };
  }
  const taxable = round2(line.quantity * line.unit_price);
  const gst = round2(taxable * rate);
  return { taxable, gst, gross: round2(taxable + gst) };
}

export interface ScheduleTotals {
  lines: number;
  taxable: number;
  gst: number;
  gross: number;
  /** Per-slab, because the invoice has to show it that way. */
  by_rate: Array<{ gst_rate: number; taxable: number; gst: number }>;
  cgst: number;
  sgst: number;
  igst: number;
  treatment: GstTreatment | null;
  in_words: string;
}

/**
 * The whole schedule.
 *
 * The CGST/SGST/IGST split needs both state codes and is left null without
 * them, rather than guessed. A guess here is a wrong tax head on a real
 * invoice, and the honest answer -- "we cannot say until we know the place
 * of supply" -- is one the screen can show.
 */
export function scheduleTotals(
  lines: readonly SupplyLineLike[],
  place?: { supplierStateCode?: string | null; placeOfSupplyCode?: string | null },
): ScheduleTotals {
  const perRate = new Map<number, { taxable: number; gst: number }>();
  let taxable = 0, gst = 0, gross = 0;
  for (const line of lines) {
    const t = lineTotals(line);
    taxable = round2(taxable + t.taxable);
    gst = round2(gst + t.gst);
    gross = round2(gross + t.gross);
    const slab = perRate.get(line.gst_rate) ?? { taxable: 0, gst: 0 };
    perRate.set(line.gst_rate, {
      taxable: round2(slab.taxable + t.taxable),
      gst: round2(slab.gst + t.gst),
    });
  }

  let cgst = 0, sgst = 0, igst = 0;
  let treatment: GstTreatment | null = null;
  const supplier = place?.supplierStateCode, pos = place?.placeOfSupplyCode;
  if (supplier && pos) {
    /*
     * Split per slab, not on the total. splitGst takes a taxable value and
     * a rate; handing it the summed tax of three different slabs would be
     * arithmetic on a number that means nothing.
     */
    for (const [rate, slab] of perRate) {
      const part = splitGst(slab.taxable, rate, supplier, pos);
      cgst = round2(cgst + part.cgst);
      sgst = round2(sgst + part.sgst);
      igst = round2(igst + part.igst);
      treatment = part.treatment;
    }
    if (perRate.size === 0) treatment = supplier === pos ? 'INTRA_STATE' : 'INTER_STATE';
  }

  return {
    lines: lines.length,
    taxable, gst, gross,
    by_rate: [...perRate.entries()]
      .map(([gst_rate, v]) => ({ gst_rate, ...v }))
      .sort((a, b) => a.gst_rate - b.gst_rate),
    cgst, sgst, igst, treatment,
    in_words: amountInWords(gross),
  };
}
