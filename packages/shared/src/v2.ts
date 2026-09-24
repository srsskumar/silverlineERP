import { z } from 'zod';
import { dateStringSchema } from './s1.js';
import { isValidUdyam, isValidGstRate } from './india.js';
import type { RoleCode } from './rbac.js';

export const V2_PERMISSIONS = ['inventory.read','inventory.manage','asset.read','asset.manage','cycle.read','cycle.manage','custom_field.manage','automation.read','automation.manage','webhook.manage','analytics.read','admin.configure'] as const;
const planning = ['cycle.read','cycle.manage','custom_field.manage','automation.read','automation.manage','analytics.read'];
export const V2_ROLE_GRANTS: Record<RoleCode,string[]> = {
 SUPER_ADMIN:[...V2_PERMISSIONS], ADMIN:[...V2_PERMISSIONS],
 PROJECT_MANAGER:[...planning,'inventory.read','asset.read'], TEAM_LEAD:['cycle.read','analytics.read','asset.read'],
 EMPLOYEE:['cycle.read','asset.read'], CLIENT_VIEWER:['cycle.read'], AUDITOR:['inventory.read','asset.read','cycle.read','analytics.read','automation.read'],
 INVENTORY_MANAGER:['inventory.read','inventory.manage','asset.read','asset.manage'], HR_MANAGER:['asset.read','analytics.read'], PAYROLL_OFFICER:[],
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[], GOVT_OBSERVER:[],
};
const text = z.string().trim().min(1).max(255);
const uuid = z.string().uuid();
export const decimalSchema = z.union([z.string(), z.number().finite()]).transform(String).refine(v => /^\d{1,12}(\.\d{1,4})?$/.test(v), 'Use a positive decimal with up to four fractional digits');
/**
 * MSMED Act 2006 s.15/16 registration (task 5c, finding B-004).
 *
 * The DB columns (migration 032) and the payables due-date maths
 * (packages/shared/src/ledgers.ts's payableDue) already existed; what was
 * missing is a way to write them — vendorSchema never carried these fields,
 * so the generic vendor CRUD route (apps/api/src/modules/inventory/routes.ts)
 * silently dropped them from every request.
 */
export const MSME_CATEGORIES = ['MICRO', 'SMALL', 'MEDIUM'] as const;
export const vendorSchema = z.object({code:text,name:text,contact:z.string().max(1000).optional(),tax_id:z.string().max(100).optional(),status:z.enum(['ACTIVE','INACTIVE']).default('ACTIVE'),
 msme_registered:z.boolean().optional(),
 udyam_number:z.string().trim().toUpperCase().max(25)
   .refine(v=>isValidUdyam(v),'Not a valid Udyam number (format UDYAM-XX-00-0000000)')
   .nullable().optional(),
 msme_category:z.enum(MSME_CATEGORIES).nullable().optional(),
 // Governs which statutory window applies — 45 days with a written
 // agreement, 15 without (payableDue). Defaults true in the DB because most
 // supply relationships are documented; explicit here only when it isn't.
 has_written_agreement:z.boolean().optional()});
export const itemSchema = z.object({code:text,name:text,unit:text.default('unit'),low_stock_threshold:decimalSchema.default('0'),unit_cost:decimalSchema.default('0'),vendor_id:uuid.nullable().optional(),status:z.enum(['ACTIVE','INACTIVE']).default('ACTIVE')});
export const stockSchema = z.object({item_id:uuid,direction:z.enum(['IN','OUT']),quantity:decimalSchema.refine(v=>Number(v)>0,'Quantity must be greater than zero'),reference:text,project_id:uuid.nullable().optional(),reason:z.string().max(2000).optional(),invoice_id:uuid.nullable().optional()});
/**
 * One line of a vendor invoice (task 5c, finding B-004).
 *
 * `invoice_lines` (migration 036) and a working three-way match
 * (apps/api/src/modules/procurement/routes.ts's /invoices/:id/match) already
 * existed; nothing could ever write a line, so the match always ran against
 * zero of them. po_line_id is optional but preferred — matchInvoiceToOrder
 * keys on it before falling back to item_id and then description.
 */
export const invoiceLineInputSchema = z.object({
 item_id:uuid.nullable().optional(),
 po_line_id:uuid.nullable().optional(),
 description:text,
 hsn_sac:z.string().regex(/^[0-9]{4,8}$/,'HSN/SAC is 4 to 8 digits'),
 quantity:z.coerce.number().positive(),
 unit_rate:z.coerce.number().nonnegative(),
 gst_rate_pct:z.coerce.number().refine(v=>isValidGstRate(v),'Not a notified GST rate').default(0),
});
export const invoiceSchema = z.object({serial_number:text,vendor_id:uuid,hsn:z.string().max(50),gst_enabled:z.boolean(),gst_rate:decimalSchema.default('0'),subtotal:decimalSchema,payment_mode:z.enum(['CASH','BANK','UPI','CREDIT']),reference:text,
 // Optional: without it, an invoice can never be linked to the purchase
 // order it bills against, and /invoices/:id/match always 422s.
 purchase_order_id:uuid.nullable().optional(),
 // Optional: when present, the server prices every line itself (via
 // computeInvoice) and overwrites subtotal/gst_rate/tax/total from the
 // lines — the legacy header fields above are never trusted once lines
 // exist. Absent, an invoice still posts as a single header row exactly as
 // it always has.
 lines:z.array(invoiceLineInputSchema).min(1,'An invoice needs at least one line').optional()});
/** PATCH /api/v1/invoices/:id/lines — replace a vendor invoice's lines wholesale. */
export const invoiceLinesUpdateSchema = z.object({lines:z.array(invoiceLineInputSchema).min(1,'An invoice needs at least one line')});
/**
 * Registering an asset (enhancement note 3).
 *
 * `category` stays free text on the wire rather than an enum: categories are
 * rows now and an organisation may add its own, so pinning the wire format to
 * today's list would make tomorrow's addition unusable. The API checks the
 * value against that organisation's own categories instead.
 */
export const assetSchema = z.object({
  asset_code:text,
  serial_number:text.optional(),
  name:text,
  category:text,
  asset_type_id:uuid.nullable().optional(),
  make:z.string().trim().max(160).optional(),
  model:z.string().trim().max(160).optional(),
  condition:text.default('GOOD'),
  /** Required when the condition is "other" -- the table enforces it too. */
  condition_note:z.string().trim().max(2000).optional(),
}).refine(v=>v.condition!=='OTHER'||!!v.condition_note?.trim(),{
  message:'Say what condition it is in',path:['condition_note'],
});

/**
 * Assigning several assets to one person at once.
 *
 * A surveyor going out carries a rover, a tripod, a radio and a battery.
 * Issuing them one form at a time is four chances to stop after three, and
 * the one that goes unrecorded is the one nobody can find later.
 */
export const assetBulkAssignSchema = z.object({
  asset_ids:z.array(uuid).min(1).max(50),
  employee_id:uuid,
  project_id:uuid.nullable().optional(),
  due_date:dateStringSchema.optional(),
  condition:text.default('GOOD'),
  reason:text,
});

/** Adding a type or a category: the "option to add more" the note asks for. */
export const assetLookupSchema = z.object({
  /**
   * Optional: derived from the label when it is left out.
   *
   * Somebody adding "Total station" from inside the register form has a name
   * in mind, not a code. Demanding one turns a one-word answer into a form,
   * and a form in the middle of another form is how people give up and pick
   * the nearest wrong type instead.
   */
  code:z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,63}$/,
    'Use capitals, digits and underscores, starting with a letter').optional(),
  label:z.string().trim().min(1).max(160),
  display_order:z.coerce.number().int().min(0).max(9999).optional(),
});

/**
 * Turn a typed name into a code.
 *
 * "Total station" becomes TOTAL_STATION. Anything that is not a letter or a
 * digit becomes an underscore, and a leading digit is prefixed, because a
 * code has to start with a letter.
 */
export function assetLookupCode(label:string):string {
  const base=label.trim().toUpperCase().replace(/[^A-Z0-9]+/g,'_')
    .replace(/^_+|_+$/g,'').slice(0,60);
  if(!base) return 'TYPE';
  return /^[A-Z]/.test(base) ? base : `X_${base}`;
}

/**
 * Handing an asset from one person to the next (§note 6).
 *
 * Not an edit of who holds it. The assignment that is open records a real
 * period in somebody's hands, and rewriting its employee would erase that
 * they ever had it — which is the one thing the trail exists to remember.
 * The open spell is closed and a new one opened, so both are on the record.
 */
export const assetTransferSchema = z.object({
  to_employee_id:uuid,
  project_id:uuid.nullable().optional(),
  due_date:dateStringSchema.optional(),
  /** What the outgoing holder handed over in. */
  condition:text.default('GOOD'),
  condition_note:z.string().trim().max(2000).optional(),
  reason:text,
});

/** Correcting the date an open allocation started. */
export const assetAllocationEditSchema = z.object({
  issued_at:dateStringSchema.optional(),
  due_date:dateStringSchema.nullable().optional(),
});
export const assetAssignSchema = z.object({employee_id:uuid,project_id:uuid.nullable().optional(),due_date:dateStringSchema.optional(),condition:text.default('GOOD'),reason:text});
/**
 * Moving an asset, and handing it back (enhancement note 3).
 *
 * `condition` is what the person handling it now observes. On a return that
 * is the *receiver's* reading, which is the whole point of recording it: the
 * person giving equipment back has every reason to call it fine.
 *
 * `returned_to_employee_id` answers "returned to whom". Without it the trail
 * ends at whoever had the thing, and a fault found next week has nobody to
 * ask.
 */
export const assetTransitionSchema = z.object({
  status:z.enum(['IN_USE','RETURNED','AVAILABLE','DAMAGED','LOST','WRITTEN_OFF']),
  condition:text,
  /** Required when the condition is "other" -- enforced by the table too. */
  condition_note:z.string().trim().max(2000).optional(),
  returned_to_employee_id:uuid.optional(),
  reason:text,
  evidence_id:uuid.optional(),
}).refine(v=>v.condition!=='OTHER'||!!v.condition_note?.trim(),{
  message:'Say what condition it is in',path:['condition_note'],
});
export const assetAuditSchema = z.object({name:text,expected_ids:z.array(uuid).max(1000),scans:z.array(z.object({asset_id:uuid,condition:text})).max(1000)});
export const cycleSchema = z.object({project_id:uuid,name:text,start_date:dateStringSchema,end_date:dateStringSchema,goal:z.string().max(2000).optional(),rollover:z.enum(['NEXT','BACKLOG']).default('NEXT')}).refine(x=>x.end_date>=x.start_date,{message:'End must follow start',path:['end_date']});
export const customFieldSchema = z.object({project_id:uuid.optional(),project_type_id:uuid.optional(),field_key:z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),name:text,field_type:z.enum(['text','number','date','select','multi_select','user','boolean']),options:z.array(text).max(100).default([]),required:z.boolean().default(false)}).refine(v=>Boolean(v.project_id)!==Boolean(v.project_type_id),'Choose one project or project type');
export const automationSchema = z.object({name:text,project_id:uuid.nullable().optional(),trigger:z.enum(['task.create','task.status','task.assign','sla.at_risk','sla.breached','task.due','cycle.close']),conditions:z.array(z.object({field:z.enum(['status','priority','assignee_id','project_id','label_id','assignee_role']),value:text})).max(10).default([]),actions:z.array(z.object({type:z.enum(['status','assign','label','comment','notify','webhook']),value:text})).min(1).max(10),active:z.boolean().default(true)});
export const webhookSchema = z.object({name:text,url:z.string().url().max(2048).refine(v=>new URL(v).protocol==='https:','HTTPS is required'),events:z.array(text).min(1).max(30),active:z.boolean().default(true)});
