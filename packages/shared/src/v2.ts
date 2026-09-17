import { z } from 'zod';
import { dateStringSchema } from './s1.js';
import type { RoleCode } from './rbac.js';

export const V2_PERMISSIONS = ['inventory.read','inventory.manage','asset.read','asset.manage','cycle.read','cycle.manage','custom_field.manage','automation.read','automation.manage','webhook.manage','analytics.read','admin.configure'] as const;
const planning = ['cycle.read','cycle.manage','custom_field.manage','automation.read','automation.manage','analytics.read'];
export const V2_ROLE_GRANTS: Record<RoleCode,string[]> = {
 SUPER_ADMIN:[...V2_PERMISSIONS], ADMIN:[...V2_PERMISSIONS],
 PROJECT_MANAGER:[...planning,'inventory.read','asset.read'], TEAM_LEAD:['cycle.read','analytics.read','asset.read'],
 EMPLOYEE:['cycle.read','asset.read'], CLIENT_VIEWER:['cycle.read'], AUDITOR:['inventory.read','asset.read','cycle.read','analytics.read','automation.read'],
 INVENTORY_MANAGER:['inventory.read','inventory.manage','asset.read','asset.manage'], HR_MANAGER:['asset.read','analytics.read'], PAYROLL_OFFICER:[],
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[],
};
const text = z.string().trim().min(1).max(255);
const uuid = z.string().uuid();
export const decimalSchema = z.union([z.string(), z.number().finite()]).transform(String).refine(v => /^\d{1,12}(\.\d{1,4})?$/.test(v), 'Use a positive decimal with up to four fractional digits');
export const vendorSchema = z.object({code:text,name:text,contact:z.string().max(1000).optional(),tax_id:z.string().max(100).optional(),status:z.enum(['ACTIVE','INACTIVE']).default('ACTIVE')});
export const itemSchema = z.object({code:text,name:text,unit:text.default('unit'),low_stock_threshold:decimalSchema.default('0'),unit_cost:decimalSchema.default('0'),vendor_id:uuid.nullable().optional(),status:z.enum(['ACTIVE','INACTIVE']).default('ACTIVE')});
export const stockSchema = z.object({item_id:uuid,direction:z.enum(['IN','OUT']),quantity:decimalSchema.refine(v=>Number(v)>0,'Quantity must be greater than zero'),reference:text,project_id:uuid.nullable().optional(),reason:z.string().max(2000).optional(),invoice_id:uuid.nullable().optional()});
export const invoiceSchema = z.object({serial_number:text,vendor_id:uuid,hsn:z.string().max(50),gst_enabled:z.boolean(),gst_rate:decimalSchema.default('0'),subtotal:decimalSchema,payment_mode:z.enum(['CASH','BANK','UPI','CREDIT']),reference:text});
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
  vendor_id:uuid.nullable().optional(),
  condition:text.default('GOOD'),
  /** Required when the condition is "other" -- the table enforces it too. */
  condition_note:z.string().trim().max(2000).optional(),
}).refine(v=>v.condition!=='OTHER'||!!v.condition_note?.trim(),{
  message:'Say what condition it is in',path:['condition_note'],
});

/** Adding a type or a category: the "option to add more" the note asks for. */
export const assetLookupSchema = z.object({
  code:z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,63}$/,
    'Use capitals, digits and underscores, starting with a letter'),
  label:z.string().trim().min(1).max(160),
  display_order:z.coerce.number().int().min(0).max(9999).optional(),
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
