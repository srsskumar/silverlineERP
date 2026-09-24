import {resolveScopes,employeeScopeClause} from '../../common/scopes.js';
import { likeContains } from "../../common/like.js";
import {scopedReads} from "../../common/scopedReads.js";
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { vendorSchema,itemSchema,stockSchema,invoiceSchema,invoiceLinesUpdateSchema,computeInvoice,assetSchema,assetLookupSchema,assetAssignSchema,assetBulkAssignSchema,assetTransferSchema,assetAllocationEditSchema,assetLookupCode,assetTransitionSchema,assetAuditSchema,assetLocation,type InvoiceLineInput as GstInvoiceLineInput } from '@silverline/shared';
import { buildAuthenticate,requirePermission,scopesForPermission } from '../../common/auth.js';
import { actor,parse,page,inOrg,mutate,version,fail,projectAccess,employeeAccess } from '../../common/domain.js';
import { itemDeltaSql,itemOnHand,lowStockLevel,notifyLowStockCrossing } from '../../common/stockLedger.js';

export async function registerInventoryRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}) {
 const {pool}=opts,auth=buildAuthenticate(opts),guard=(p:string)=>requirePermission(auth,p);
 async function assetClause(req:FastifyRequest,values:unknown[],column:string){
  const u=actor(req),permission=u.permissions.includes('asset.manage')?'asset.manage':u.permissions.includes('inventory.read')?'inventory.read':null;
  const scope=permission?resolveScopes(await scopesForPermission(req,permission)):null;if(scope?.global)return 'TRUE';
  const owned=`EXISTS(SELECT 1 FROM asset_assignments own JOIN users me ON me.employee_id=own.employee_id WHERE own.asset_id=${column} AND own.returned_at IS NULL AND me.id=$${values.push(u.id)})`;if(!scope)return owned;
  const employees=await employeeScopeClause(pool,u.orgId,scope,values),projects=values.push(scope.projects),creator=values.push(u.id);
  return `(${owned} OR EXISTS(SELECT 1 FROM asset_assignments aa WHERE aa.asset_id=${column} AND aa.returned_at IS NULL AND (aa.project_id=ANY($${projects}::uuid[]) OR aa.employee_id IN(SELECT employees.id FROM employees WHERE ${employees}))) OR ${column} IN(SELECT id FROM assets WHERE created_by=$${creator}))`;
 }
 async function assetAccess(req:FastifyRequest,id:string){const values:unknown[]=[id,actor(req).orgId],clause=await assetClause(req,values,'a.id');if(!(await pool.query(`SELECT 1 FROM assets a WHERE a.id=$1 AND a.org_id=$2 AND ${clause}`,values)).rowCount)fail('FORBIDDEN','Asset is outside your scope',403);}

 app.get('/api/v1/assets/eligible-employees',{preHandler:guard('asset.manage')},async req=>({data:(await scopedReads(pool,pool,actor(req)).query("SELECT id,emp_no,first_name,last_name FROM employees WHERE org_id=$1 AND status='ACTIVE' ORDER BY first_name,id LIMIT 100",[actor(req).orgId])).rows}));
 app.get('/api/v1/inventory/eligible-projects',{preHandler:guard('inventory.read')},async req=>({data:(await scopedReads(pool,pool,actor(req)).query("SELECT id,code,name FROM projects WHERE org_id=$1 AND status='ACTIVE' ORDER BY name,id LIMIT 100",[actor(req).orgId])).rows}));

 /**
  * The category and type must be ones this organisation actually has.
  *
  * Checked here rather than with a CHECK constraint, because the lists are
  * rows an organisation extends. Without this an asset can be filed under a
  * category that exists nowhere, and it then vanishes from every filter that
  * joins on the lookup -- present in the register and absent from every view
  * of it, which is worse than being refused.
  *
  * Legacy categories were folded into the lookup by migration 057, so rows
  * written before this still validate.
  */
 async function checkAssetVocabulary(db:import('pg').PoolClient,orgId:string,input:Record<string,unknown>) {
  if(input.category!==undefined){
   /*
    * Given as a code or as an id.
    *
    * The register stores the code, but a dropdown built from the category
    * list submits the row's id — so accepting only the code would mean every
    * form that does the sensible thing gets refused. The id is resolved back
    * to the code here rather than storing two kinds of value in one column.
    */
   const raw=String(input.category);
   const looksLikeId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
   const found=await db.query(
    looksLikeId
     ?'SELECT code FROM asset_categories WHERE org_id=$1 AND id=$2 AND active'
     :'SELECT code FROM asset_categories WHERE org_id=$1 AND code=$2 AND active',
    [orgId,raw]);
   if(!found.rowCount)fail('UNKNOWN_CATEGORY',`There is no active asset category ${raw}. Add it first.`,422);
   input.category=String(found.rows[0].code);
  }
  if(input.asset_type_id){
   const ok=await db.query('SELECT 1 FROM asset_types WHERE org_id=$1 AND id=$2 AND active',[orgId,String(input.asset_type_id)]);
   if(!ok.rowCount)fail('UNKNOWN_ASSET_TYPE','There is no active asset type with that id',422);
  }
 }

 for(const [path,table,schema,permission] of [
  ['vendors','vendors',vendorSchema,'inventory'],['inventory/items','inventory_items',itemSchema,'inventory'],['assets','assets',assetSchema,'asset'],
 ] as const) {
  app.get(`/api/v1/${path}`,{preHandler:guard(`${permission}.read`)},async req=>{
   const u=actor(req),{limit,offset,q}=page(req),values:unknown[]=[u.orgId,limit+1,offset];
   let where='a.org_id=$1';
   if(q.search){values.push(likeContains(q.search));where+=` AND (a.name ILIKE $${values.length} ESCAPE '!' OR ${table==='assets'?'a.asset_code':'a.code'} ILIKE $${values.length} ESCAPE '!')`;}
   if(table==='assets')where+=` AND ${await assetClause(req,values,'a.id')}`;
   const extra=table==='inventory_items'
    // A transfer moves stock between locations and leaves the item's total alone.
    ?`,COALESCE((SELECT sum(${itemDeltaSql()}) FROM stock_transactions WHERE item_id=a.id),0)::text AS available`
    :table==='assets'
     // The register's own columns read as words, and each asset says where
     // it is and who has it without a second request per row.
     ?`,(SELECT t.label FROM asset_types t WHERE t.id=a.asset_type_id) AS asset_type_label,
        (SELECT c.label FROM asset_categories c WHERE c.org_id=a.org_id AND c.code=a.category) AS category_label,
        (SELECT CASE WHEN count(*)>0 THEN 'IN_FIELD' ELSE 'IN_OFFICE' END
           FROM asset_assignments x WHERE x.asset_id=a.id AND x.returned_at IS NULL) AS location,
        (SELECT COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)),''),e.emp_no)
           FROM asset_assignments x JOIN employees e ON e.id=x.employee_id
          WHERE x.asset_id=a.id AND x.returned_at IS NULL LIMIT 1) AS held_by,
        -- The holder's number and the date it went out, so chasing a missing
        -- instrument does not start with looking somebody up in the directory.
        (SELECT e.phone FROM asset_assignments x JOIN employees e ON e.id=x.employee_id
          WHERE x.asset_id=a.id AND x.returned_at IS NULL LIMIT 1) AS held_by_phone,
        (SELECT e.emp_no FROM asset_assignments x JOIN employees e ON e.id=x.employee_id
          WHERE x.asset_id=a.id AND x.returned_at IS NULL LIMIT 1) AS held_by_emp_no,
        (SELECT x.issued_at FROM asset_assignments x
          WHERE x.asset_id=a.id AND x.returned_at IS NULL LIMIT 1) AS assigned_on,
        -- How a storeman identifies a thing: what it is and which one.
        -- A name alone gives three rows reading "Rover" and no way to tell
        -- which is being signed out.
        COALESCE((SELECT t.label FROM asset_types t WHERE t.id=a.asset_type_id), a.name)
          ||COALESCE(' · '||NULLIF(a.serial_number,''),'')
          ||' · '||a.asset_code AS picker_label,
        (SELECT p.name FROM asset_assignments x JOIN projects p ON p.id=x.project_id
          WHERE x.asset_id=a.id AND x.returned_at IS NULL LIMIT 1) AS held_for_project`
     :'';
   const rows=await pool.query(`SELECT a.*${extra} FROM ${table} a WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3`,values);
   return {data:rows.rows.slice(0,limit),has_more:rows.rows.length>limit,next_offset:rows.rows.length>limit?offset+limit:null};
  });
  app.post(`/api/v1/${path}`,{preHandler:guard(`${permission}.manage`)},async(req,reply)=>{
   const input=parse(schema as any,req.body) as Record<string,unknown>,u=actor(req);
   const row=await mutate(pool,req,`${permission}.create`,table,async db=>{
    if(input.vendor_id)await inOrg(db,'vendors',String(input.vendor_id),u.orgId);
    if(table==='assets')await checkAssetVocabulary(db,u.orgId,input);
    const keys=Object.keys(input),values=[u.orgId,u.id,...Object.values(input)];
    const r=await db.query(`INSERT INTO ${table}(org_id,created_by,${keys.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,values);return r.rows[0];
   });return reply.code(201).send(row);
  });
  app.patch(`/api/v1/${path}/:id`,{preHandler:guard(`${permission}.manage`)},async req=>{
   const parsed=parse(schema as any,req.body) as Record<string,unknown>,u=actor(req),id=(req.params as {id:string}).id;
   // A PATCH is a partial update, but every schema here is the same one POST
   // uses to create a row -- its zod defaults (status:'ACTIVE', condition:
   // 'GOOD', ...) fill in any key the caller left out. Left alone, editing
   // one field (say, a name) would silently reset every defaulted field the
   // form doesn't carry back to its default, reactivating a deliberately
   // deactivated item. Keep only the keys the caller actually sent.
   const sent=(req.body??{}) as Record<string,unknown>;
   const input=Object.fromEntries(Object.entries(parsed).filter(([k])=>k in sent));
   return mutate(pool,req,`${permission}.update`,table,async db=>{
    const old=await inOrg(db,table,id,u.orgId,true);if(table==='assets')await assetAccess(req,id);version(req,old as {version:number});
    if(input.vendor_id)await inOrg(db,'vendors',String(input.vendor_id),u.orgId);
    if(table==='assets')await checkAssetVocabulary(db,u.orgId,input);
    const keys=Object.keys(input),values=[id,...Object.values(input)];
    const r=await db.query(`UPDATE ${table} SET ${keys.map((k,i)=>`${k}=$${i+2}`).join(',')},version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,values);return r.rows[0];
   });
  });
 }
 app.get('/api/v1/inventory/transactions',{preHandler:guard('inventory.read')},async req=>{
  const u=actor(req),{limit,offset,q}=page(req);
  const rows=await pool.query(`SELECT t.*,i.name AS item_name FROM stock_transactions t JOIN inventory_items i ON i.id=t.item_id WHERE t.org_id=$1 AND ($4::uuid IS NULL OR t.item_id=$4) ORDER BY t.created_at DESC,t.id DESC LIMIT $2 OFFSET $3`,[u.orgId,limit+1,offset,q.item_id||null]);
  return {data:rows.rows.slice(0,limit),has_more:rows.rows.length>limit};
 });
 app.post('/api/v1/inventory/transactions',{preHandler:guard('inventory.manage')},async(req,reply)=>{
  const input=parse(stockSchema,req.body),u=actor(req);
  if(input.project_id)await projectAccess(pool,req,input.project_id);
  const row=await mutate(pool,req,'inventory.post','stock_transaction',async db=>{
   const item=await inOrg(db,'inventory_items',input.item_id,u.orgId,true);
   if(item.status!=='ACTIVE')fail('ITEM_INACTIVE','Stock can only be posted to active items');
   if(input.project_id){const p=await inOrg(db,'projects',input.project_id,u.orgId,true);if(p.status!=='ACTIVE')fail('PROJECT_INACTIVE','Project must be active');}
   if(input.invoice_id)await inOrg(db,'invoices',input.invoice_id,u.orgId);
   // Lock the item before computing its ledger balance: concurrent withdrawals serialize.
   const before=await itemOnHand(db,input.item_id);
   if(input.direction==='OUT'&&before<Number(input.quantity))fail('INSUFFICIENT_STOCK','Posting would make available stock negative',409);
   const r=await db.query('INSERT INTO stock_transactions(org_id,item_id,direction,quantity,reference,project_id,invoice_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[u.orgId,input.item_id,input.direction,input.quantity,input.reference,input.project_id??null,input.invoice_id??null,input.reason??null,u.id]);
   const available=await itemOnHand(db,input.item_id);
   const low=available<=lowStockLevel(item);
   await notifyLowStockCrossing(db,{orgId:u.orgId,item,before,after:available,transactionId:String(r.rows[0].id)});
   return {...r.rows[0],available:String(available),low_stock:low};
  });return reply.code(201).send(row);
 });
 // Read behind invoice.read, the permission granted for exactly this. It was
 // gated on inventory.read, so the payables officer who holds invoice.read
 // and invoice.manage could match and pay an invoice but never list one.
 app.get('/api/v1/invoices',{preHandler:guard('invoice.read')},async req=>{const {limit,offset}=page(req),rows=(await pool.query('SELECT * FROM invoices WHERE org_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',[actor(req).orgId,limit+1,offset])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
 /**
  * Whether a vendor invoice's lines can still be changed, and why not if not
  * (fix round 1, item 1 on task 5c / finding B-004).
  *
  * UNMATCHED and EXCEPTION are both editable: EXCEPTION means a match was
  * run and failed, which is exactly the state somebody needs to correct a
  * line from — refusing it left override-with-reason as the only way out of
  * a mismatch, even a mismatch caused by a typo in the invoice's own lines.
  * MATCHED and OVERRIDDEN are not: a recorded match is a decision, and
  * changing the lines under it without reversing that decision first would
  * invalidate it silently.
  *
  * Blocked independently of match_status once the invoice is approved or
  * cancelled, has any payment allocated against it (even a partial one —
  * changing what a real payment was allocated against is never safe), or
  * sits on a payment run that is still open or has already paid.
  */
 async function invoiceLinesLockReason(db:Pool|import('pg').PoolClient,id:string,invoice:Record<string,any>):Promise<string|null> {
  if(!['UNMATCHED','EXCEPTION'].includes(String(invoice.match_status)))
   return 'This invoice has already been matched or overridden. Reverse the match before changing its lines.';
  if(['APPROVED','CANCELLED'].includes(String(invoice.lifecycle_status)))
   return `An invoice at ${invoice.lifecycle_status} cannot have its lines changed`;
  // Fix round 2: on_hold and disputed were missing here entirely, so a held
  // or disputed invoice's lines could be edited silently -- the hold/dispute
  // is a decision about the invoice as it stands, and changing its lines
  // under either invalidates that decision the same way changing them under
  // a recorded match would.
  if(invoice.on_hold)
   return `This invoice is on hold${invoice.hold_reason?` (${invoice.hold_reason})`:''}. Release the hold before changing its lines.`;
  if(invoice.disputed)
   return `This invoice is disputed${invoice.dispute_reason?` (${invoice.dispute_reason})`:''}. Resolve the dispute before changing its lines.`;
  const status=(await db.query(
   `SELECT
      COALESCE((SELECT sum(a.amount + a.tds_amount + a.advance_adjusted)
                FROM payment_allocations a JOIN payments pm ON pm.id = a.payment_id
                WHERE a.document_type = 'VENDOR_INVOICE' AND a.document_id = $1
                  AND a.reversed_at IS NULL AND pm.reversed_at IS NULL), 0) AS settled,
      EXISTS(SELECT 1 FROM payment_run_lines l JOIN payment_runs r ON r.id = l.run_id
             WHERE l.document_type = 'VENDOR_INVOICE' AND l.document_id = $1
               AND r.status IN ('DRAFT','APPROVED','PAID')) AS in_run`,
   [id])).rows[0];
  if(Number(status.settled)>0.005)
   return 'This invoice has a payment allocated against it. Its lines cannot be changed.';
  if(status.in_run)
   return 'This invoice is on a payment run. Its lines cannot be changed until it is taken off the run.';
  return null;
 }
 async function assertInvoiceLinesEditable(db:import('pg').PoolClient,id:string,invoice:Record<string,any>) {
  const reason=await invoiceLinesLockReason(db,id,invoice);
  if(reason)fail('INVALID_STATUS',reason,409);
 }
 app.get('/api/v1/invoices/:id',{preHandler:guard('invoice.read')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,invoice=await inOrg(pool,'invoices',id,u.orgId);
  const vendor=(await pool.query(
   'SELECT name,udyam_number,msme_category,msme_registered,has_written_agreement FROM vendors WHERE id=$1',
   [invoice.vendor_id])).rows[0];
  const lines=(await pool.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no',[id])).rows;
  const lockReason=await invoiceLinesLockReason(pool,id,invoice);
  return {data:{...invoice,vendor_name:vendor?.name??null,
   vendor_udyam_number:vendor?.udyam_number??null,vendor_msme_category:vendor?.msme_category??null,
   vendor_msme_registered:vendor?.msme_registered??null,vendor_has_written_agreement:vendor?.has_written_agreement??null,
   lines_editable:!lockReason,lines_lock_reason:lockReason,
   lines}};
 });
 const round2=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
 /**
  * Where a vendor invoice's lines are priced from (task 5c, finding B-004).
  *
  * Reuses the same GST engine every other GST document in the system reuses
  * (computeInvoice, packages/shared/src/india.ts) rather than reinventing a
  * second tax calculation. The supplier's state is the vendor's own primary
  * GST registration where one is on file; place of supply follows the
  * linked order's, since that is what the order already records about where
  * the goods are delivered. Either missing falls back to the organisation's
  * own state, and both missing falls back to treating the purchase as
  * intra-state -- the common case, and never a case that overstates tax.
  */
 async function gstCodesFor(db:import('pg').PoolClient,orgId:string,vendorId:string,purchaseOrderId:string|null) {
  const vendorState=(await db.query(
   `SELECT state_code FROM party_gst_registrations
     WHERE party_type='VENDOR' AND party_id=$1 AND status='ACTIVE'
     ORDER BY is_primary DESC LIMIT 1`,[vendorId])).rows[0]?.state_code as string|undefined;
  const orgState=(await db.query('SELECT primary_state_code FROM organizations WHERE id=$1',[orgId])).rows[0]?.primary_state_code as string|undefined;
  const poPlaceOfSupply=purchaseOrderId
   ?(await db.query('SELECT place_of_supply FROM purchase_orders WHERE id=$1',[purchaseOrderId])).rows[0]?.place_of_supply as string|undefined
   :undefined;
  const supplierStateCode=vendorState??orgState??'00';
  const placeOfSupplyCode=poPlaceOfSupply??orgState??supplierStateCode;
  return {supplierStateCode,placeOfSupplyCode};
 }
 async function priceInvoiceLines(db:import('pg').PoolClient,orgId:string,vendorId:string,purchaseOrderId:string|null,lines:{description:string;hsn_sac:string;quantity:number;unit_rate:number;gst_rate_pct:number}[]) {
  const {supplierStateCode,placeOfSupplyCode}=await gstCodesFor(db,orgId,vendorId,purchaseOrderId);
  const gstLines:GstInvoiceLineInput[]=lines.map(l=>({description:l.description,hsnSac:l.hsn_sac,quantity:l.quantity,unitRate:l.unit_rate,gstRatePct:l.gst_rate_pct}));
  return computeInvoice({lines:gstLines,supplierStateCode,placeOfSupplyCode});
 }
 /**
  * The legacy header gst_enabled/gst_rate from the priced lines (fix round
  * 1, item 5 on task 5c / finding B-004).
  *
  * Once lines exist they are the authority on tax, the same way they
  * already are for subtotal/tax/total -- leaving gst_enabled/gst_rate as
  * whatever the client sent would keep two disagreeing answers to "is this
  * taxed, and at what rate" on the same row. A single rate cannot represent
  * several lines taxed at different notified rates exactly, so gst_rate
  * becomes the effective rate the computed tax actually works out to
  * (taxTotal / taxableValue), which is the one number consistent with
  * computeInvoice's own total: subtotal + round(subtotal*gst_rate/100)
  * reproduces computed.total for a single-rate invoice exactly, and comes
  * closest to it otherwise.
  */
 function gstFieldsFromComputed(computed:ReturnType<typeof computeInvoice>) {
  const gstEnabled=computed.taxTotal>0.005;
  const gstRate=gstEnabled&&computed.taxableValue>0.005
   ?round2((computed.taxTotal/computed.taxableValue)*100)
   :0;
  return {gstEnabled,gstRate};
 }
 /** Every line's po_line_id, if given, has to be on the invoice's own order — not just any order in the org. */
 async function checkLinePoIds(db:import('pg').PoolClient,purchaseOrderId:string|null,lines:{po_line_id?:string|null}[]) {
  const withLink=lines.filter(l=>l.po_line_id);
  if(!withLink.length)return;
  if(!purchaseOrderId)fail('VALIDATION_ERROR','A line cannot reference a purchase-order line unless the invoice itself is linked to that purchase order');
  const ids=new Set((await db.query('SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1',[purchaseOrderId])).rows.map(r=>String(r.id)));
  for(const l of withLink)if(!ids.has(String(l.po_line_id)))fail('VALIDATION_ERROR',"A line references a purchase-order line that is not on this invoice's purchase order");
 }
 /**
  * Every line's item_id, if given, has to belong to this organisation (fix
  * round 1, item 2 on task 5c / finding B-004).
  *
  * The FK alone (`invoice_lines.item_id REFERENCES inventory_items(id)`)
  * only proves the row exists somewhere -- inventory_items carries no
  * per-organisation uniqueness that would stop it pointing at another
  * tenant's item. Checked the same way checkLinePoIds already checks
  * po_line_id, rather than trusting the column type to do a tenancy check
  * it was never built for.
  */
 async function checkLineItemIds(db:import('pg').PoolClient,orgId:string,lines:{item_id?:string|null}[]) {
  const withItem=[...new Set(lines.filter(l=>l.item_id).map(l=>String(l.item_id)))];
  if(!withItem.length)return;
  const found=await db.query('SELECT id FROM inventory_items WHERE org_id=$1 AND id=ANY($2::uuid[])',[orgId,withItem]);
  if(found.rowCount!==withItem.length)fail('VALIDATION_ERROR','A line references an item that does not belong to this organisation');
 }
 async function writeInvoiceLines(db:import('pg').PoolClient,orgId:string,invoiceId:string,lines:{item_id?:string|null;po_line_id?:string|null;description:string;hsn_sac:string;quantity:number;unit_rate:number;gst_rate_pct:number}[],computed:ReturnType<typeof computeInvoice>) {
  for(let idx=0;idx<lines.length;idx++){
   const line=lines[idx],c=computed.lines[idx];
   await db.query(
    `INSERT INTO invoice_lines(org_id,invoice_id,line_no,item_id,po_line_id,description,hsn_sac,quantity,unit_rate,discount_amount,taxable_value,gst_rate_pct,cgst_amount,sgst_amount,igst_amount,line_total)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [orgId,invoiceId,idx+1,line.item_id??null,line.po_line_id??null,line.description,line.hsn_sac,
     line.quantity,line.unit_rate,0,c.taxableValue.toFixed(2),line.gst_rate_pct,
     c.cgst.toFixed(2),c.sgst.toFixed(2),c.igst.toFixed(2),c.lineTotal.toFixed(2)]);
  }
 }
 app.post('/api/v1/invoices',{preHandler:guard('inventory.manage')},async(req,reply)=>{
  const i=parse(invoiceSchema,req.body),u=actor(req);
  const row=await mutate(pool,req,'invoice.create','invoice',async db=>{
   await inOrg(db,'vendors',i.vendor_id,u.orgId);
   if(i.purchase_order_id){
    // Org membership alone isn't enough: a PO from a different vendor would
    // still belong to this org, and matching an invoice against someone
    // else's order makes the three-way match meaningless.
    const po=await inOrg(db,'purchase_orders',i.purchase_order_id,u.orgId);
    if(String(po.vendor_id)!==String(i.vendor_id))fail('PO_VENDOR_MISMATCH','This purchase order belongs to a different vendor than the invoice');
   }
   if(Number(i.gst_rate)>100)fail('VALIDATION_ERROR','Tax rate must be between zero and 100');

   // The header's legacy subtotal/tax/total/gst_enabled/gst_rate are never
   // trusted once lines are given -- the server prices every line itself
   // and every one of these header fields is derived from that, never from
   // what the client sent.
   let subtotal=Number(i.subtotal);
   let gstEnabled=i.gst_enabled;
   let gstRate=Number(i.gst_rate);
   let tax=gstEnabled?round2(subtotal*gstRate/100):0;
   let total=round2(subtotal+tax);
   let computed:ReturnType<typeof computeInvoice>|null=null;
   if(i.lines?.length){
    await checkLinePoIds(db,i.purchase_order_id??null,i.lines);
    await checkLineItemIds(db,u.orgId,i.lines);
    computed=await priceInvoiceLines(db,u.orgId,i.vendor_id,i.purchase_order_id??null,i.lines);
    subtotal=computed.taxableValue;tax=computed.taxTotal;total=computed.total;
    ({gstEnabled,gstRate}=gstFieldsFromComputed(computed));
   }

   const r=await db.query(
    `INSERT INTO invoices(org_id,serial_number,vendor_id,hsn,gst_enabled,gst_rate,subtotal,tax,total,payment_mode,reference,created_by,purchase_order_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [u.orgId,i.serial_number,i.vendor_id,i.hsn,gstEnabled,gstRate.toFixed(2),
     subtotal.toFixed(2),tax.toFixed(2),total.toFixed(2),i.payment_mode,i.reference,u.id,i.purchase_order_id??null]);

   if(i.lines?.length&&computed)await writeInvoiceLines(db,u.orgId,r.rows[0].id,i.lines,computed);
   return r.rows[0];
  });return reply.code(201).send(row);
 });
 /**
  * Replace a vendor invoice's lines wholesale (task 5c, finding B-004).
  *
  * Only while the invoice is still unmatched and not yet approved or
  * cancelled -- once a three-way match has been recorded against a set of
  * lines, changing them under it would silently invalidate a decision that
  * was already made and, worse, one a payment run may already rely on.
  */
 app.patch('/api/v1/invoices/:id/lines',{preHandler:guard('invoice.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,input=parse(invoiceLinesUpdateSchema,req.body);
  return {data:await mutate(pool,req,'invoice.lines.update','invoice',async db=>{
   const invoice=await inOrg(db,'invoices',id,u.orgId,true);
   version(req,invoice as {version:number});
   await assertInvoiceLinesEditable(db,id,invoice);

   const purchaseOrderId=invoice.purchase_order_id?String(invoice.purchase_order_id):null;
   await checkLinePoIds(db,purchaseOrderId,input.lines);
   await checkLineItemIds(db,u.orgId,input.lines);
   const computed=await priceInvoiceLines(db,u.orgId,String(invoice.vendor_id),purchaseOrderId,input.lines);

   await db.query('DELETE FROM invoice_lines WHERE invoice_id=$1',[id]);
   await writeInvoiceLines(db,u.orgId,id,input.lines,computed);

   // An edit invalidates whatever match_status was on record -- EXCEPTION
   // most often, since that is the one state this route exists to let
   // somebody correct — so it resets to UNMATCHED and forces a fresh match
   // rather than leaving a stale verdict standing over lines that changed
   // under it. gst_enabled/gst_rate are re-derived the same way POST
   // /invoices derives them, so an edit cannot leave them disagreeing with
   // the lines that now justify subtotal/tax/total.
   const {gstEnabled,gstRate}=gstFieldsFromComputed(computed);
   const updated=(await db.query(
    "UPDATE invoices SET subtotal=$2,tax=$3,total=$4,gst_enabled=$5,gst_rate=$6,match_status='UNMATCHED',version=version+1 WHERE id=$1 RETURNING *",
    [id,computed.taxableValue.toFixed(2),computed.taxTotal.toFixed(2),computed.total.toFixed(2),
     gstEnabled,gstRate.toFixed(2)])).rows[0];
   const lines=(await db.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no',[id])).rows;
   return {...updated,lines};
  })};
 });
 /*
  * The asset vocabulary (enhancement note 3).
  *
  * Rows rather than a fixed list, because the note asks for "an option to
  * add more" and nobody can enumerate in advance every instrument a survey
  * firm will buy. A register that refuses the thing you just bought gets
  * kept in a spreadsheet instead, which is the register losing quietly.
  *
  * Reading them needs only asset.read -- every form that registers an asset
  * has to populate its dropdowns. Adding one needs asset.manage: a
  * vocabulary anybody can extend stops being a vocabulary.
  */
 for(const [path,table] of [['asset-types','asset_types'],['asset-categories','asset_categories']] as const) {
  app.get(`/api/v1/${path}`,{preHandler:guard('asset.read')},async req=>{
   const u=actor(req),q=(req.query??{}) as {include_inactive?:string};
   const rows=(await pool.query(
    `SELECT id,code,label,display_order,active FROM ${table}
      WHERE org_id=$1 AND ($2::boolean OR active)
      ORDER BY display_order,label`,
    [u.orgId,q.include_inactive==='true'])).rows;
   return {data:rows};
  });
  app.post(`/api/v1/${path}`,{preHandler:guard('asset.manage')},async(req,reply)=>{
   const i=parse(assetLookupSchema,req.body),u=actor(req);
   // Somebody adding a type from inside the register form has a name in
   // mind, not a code.
   const code=i.code ?? assetLookupCode(i.label);
   const row=await mutate(pool,req,`asset.${table}.create`,table,async db=>{
    const clash=await db.query(`SELECT id,label,active FROM ${table} WHERE org_id=$1 AND code=$2`,[u.orgId,code]);
    if(clash.rowCount){
     // Re-adding something that was retired reinstates it rather than
     // failing: "it already exists, inactive" is not an answer anybody can
     // act on from a form with one text box.
     if(!clash.rows[0].active)return (await db.query(`UPDATE ${table} SET active=true,label=$2 WHERE id=$1 RETURNING id,code,label,display_order,active`,[clash.rows[0].id,i.label])).rows[0];
     fail('ALREADY_EXISTS',`${clash.rows[0].label} already uses that code`,409);
    }
    return (await db.query(
     `INSERT INTO ${table}(org_id,code,label,display_order,created_by)
      VALUES($1,$2,$3,COALESCE($4,500),$5) RETURNING id,code,label,display_order,active`,
     [u.orgId,code,i.label,i.display_order??null,u.id])).rows[0];
   });
   return reply.code(201).send(row);
  });
 }

 app.get('/api/v1/assets/resolve',{preHandler:guard('asset.read')},async req=>{
  const u=actor(req),q=req.query as {code:string};
  const row=await pool.query('SELECT id FROM assets WHERE org_id=$1 AND (asset_code=$2 OR serial_number=$2)',[u.orgId,q.code]);
  if(!row.rowCount)fail('NOT_FOUND','No asset matches this code',404);
  await assetAccess(req,row.rows[0].id);return {id:row.rows[0].id};
 });
 app.get('/api/v1/assets/:id',{preHandler:guard('asset.read')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,row=await inOrg(pool,'assets',id,u.orgId);
  /*
   * The history of one asset, in the words people use (§note 3).
   *
   * Every spell in somebody's hands: who held it, on which project, what
   * state it went out in, what state it came back in, and who took it back.
   * Ids alone make the screen unreadable and the answer to "who had it when
   * it broke" a second query somebody has to know to run.
   */
  const assignments=await pool.query(
   `SELECT a.*,
           COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)),''),e.emp_no) AS employee_name,
           e.emp_no,
           COALESCE(NULLIF(trim(concat_ws(' ', rt.first_name, rt.last_name)),''),rt.emp_no) AS returned_to_name,
           p.name AS project_name, p.code AS project_code,
           ru.username AS received_by_username
      FROM asset_assignments a
      LEFT JOIN employees e  ON e.id  = a.employee_id
      LEFT JOIN employees rt ON rt.id = a.returned_to_employee_id
      LEFT JOIN projects  p  ON p.id  = a.project_id
      LEFT JOIN users     ru ON ru.id = a.received_by
     WHERE a.asset_id=$1 ORDER BY a.issued_at DESC LIMIT 100`,[id]);
  const type=row.asset_type_id
   ? (await pool.query('SELECT code,label FROM asset_types WHERE id=$1',[row.asset_type_id])).rows[0]
   : null;
  const category=(await pool.query('SELECT code,label FROM asset_categories WHERE org_id=$1 AND code=$2',[u.orgId,row.category])).rows[0];
  const open=assignments.rows.find(a=>!a.returned_at)??null;
  await assetAccess(req,id);
  return {
   ...row,
   asset_type_code:type?.code??null, asset_type_label:type?.label??null,
   category_label:category?.label??row.category,
   // Worked out from the open allocation rather than stored beside it: two
   // columns that can disagree leave nobody able to say which is lying.
   location:assetLocation(open),
   currently_with:open?{
    employee_id:open.employee_id, employee_name:open.employee_name,
    project_id:open.project_id, project_name:open.project_name,
    issued_at:open.issued_at, due_date:open.due_date,
   }:null,
   assignments:assignments.rows,
  };
 });
 app.post('/api/v1/assets/:id/assign',{preHandler:guard('asset.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,i=parse(assetAssignSchema,req.body);
  await employeeAccess(pool,req,i.employee_id);if(i.project_id)await projectAccess(pool,req,i.project_id);
  return mutate(pool,req,'asset.assign','asset',async db=>{
   const asset=await inOrg(db,'assets',id,u.orgId,true);await assetAccess(req,id);version(req,asset as {version:number});
   if(!['AVAILABLE','RETURNED'].includes(asset.status))fail('ASSET_UNAVAILABLE','Asset is not available for assignment',409);
   const e=await inOrg(db,'employees',i.employee_id,u.orgId,true);if(e.status!=='ACTIVE')fail('EMPLOYEE_INACTIVE','Only active employees may receive assets');
   if(i.project_id){const p=await inOrg(db,'projects',i.project_id,u.orgId,true);if(p.status!=='ACTIVE')fail('PROJECT_INACTIVE','Project must be active');}
   await db.query('INSERT INTO asset_assignments(org_id,asset_id,employee_id,project_id,due_date,condition,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[u.orgId,id,i.employee_id,i.project_id??null,i.due_date??null,i.condition,i.reason,u.id]);
   return (await db.query("UPDATE assets SET status='ASSIGNED',condition=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id,i.condition])).rows[0];
  });
 });
 /**
  * Issue several assets to one person at once (§note 5).
  *
  * A surveyor going out carries a rover, a tripod, a radio and a battery.
  * Issuing them one form at a time is four chances to stop after three, and
  * the one that goes unrecorded is the one nobody can find later.
  *
  * An asset already out with somebody else is named and the rest still go.
  * Refusing the whole issue because one item is elsewhere means doing the
  * other three again by hand, which is how people stop using the register.
  */
 /**
  * Hand an asset from whoever has it to somebody else (§note 6).
  *
  * Not an edit of who holds it. The open assignment records a real period in
  * somebody's hands, and rewriting its employee would erase that they ever
  * had it — which is the one thing the trail exists to remember. The spell
  * is closed with the condition it came back in, and a new one opened, so
  * both are on the record and the handover has a date.
  */
 app.post('/api/v1/assets/:id/transfer',{preHandler:guard('asset.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,i=parse(assetTransferSchema,req.body);
  await employeeAccess(pool,req,i.to_employee_id);
  if(i.project_id)await projectAccess(pool,req,i.project_id);
  return mutate(pool,req,'asset.transfer','asset',async db=>{
   const asset=await inOrg(db,'assets',id,u.orgId,true);await assetAccess(req,id);
   version(req,asset as {version:number});
   if(i.condition==='OTHER'&&!i.condition_note?.trim())fail('VALIDATION_ERROR','Say what condition it is in',422);

   const to=await inOrg(db,'employees',i.to_employee_id,u.orgId,true);
   if(to.status!=='ACTIVE')fail('EMPLOYEE_INACTIVE','Only active employees may receive assets');

   const open=(await db.query(
    'SELECT id,employee_id FROM asset_assignments WHERE asset_id=$1 AND returned_at IS NULL',
    [id])).rows[0];
   if(!open)fail('NOT_ALLOCATED','This asset is not out with anybody. Issue it instead.',409);
   if(String(open.employee_id)===i.to_employee_id)fail('SAME_HOLDER','That is who already has it',422);

   await db.query(
    `UPDATE asset_assignments
        SET returned_at=now(), return_condition=$2, return_condition_note=$3,
            received_by=$4, returned_to_employee_id=$5
      WHERE id=$1`,
    [open.id,i.condition,i.condition_note??null,u.id,i.to_employee_id]);
   await db.query(
    `INSERT INTO asset_assignments(org_id,asset_id,employee_id,project_id,due_date,condition,reason,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [u.orgId,id,i.to_employee_id,i.project_id??null,i.due_date??null,i.condition,i.reason,u.id]);
   return (await db.query(
    "UPDATE assets SET status='ASSIGNED',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
    [id])).rows[0];
  });
 });

 /**
  * Correct an open allocation's dates.
  *
  * The date it went out, recorded wrong. Who holds it is not editable here
  * on purpose -- that is a transfer, and it has its own record.
  */
 app.patch('/api/v1/asset-allocations/:id',{preHandler:guard('asset.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,i=parse(assetAllocationEditSchema,req.body);
  return mutate(pool,req,'asset.allocation.update','asset_assignment',async db=>{
   const row=await inOrg(db,'asset_assignments',id,u.orgId,true);
   if(row.returned_at)fail('ALREADY_RETURNED','That spell has ended. Correcting a closed record would rewrite history.',409);
   await assetAccess(req,String(row.asset_id));
   return (await db.query(
    `UPDATE asset_assignments
        SET issued_at=COALESCE($2::timestamptz,issued_at),
            due_date=CASE WHEN $3::boolean THEN $4::date ELSE due_date END
      WHERE id=$1 RETURNING *`,
    [id,i.issued_at?`${i.issued_at}T00:00:00Z`:null,
     i.due_date!==undefined,i.due_date??null])).rows[0];
  });
 });

 /**
  * Where equipment has been (§note 7).
  *
  * The general audit trail answers "which row changed", with an action name
  * and a JSON diff. That is the right answer to a different question. Nobody
  * chasing a rover wants asset.transfer and two identifiers; they want to
  * read down a page and see the thing leave one pair of hands and arrive in
  * another, with the state it was in each time.
  *
  * A movement is an event, and an allocation row holds two of them: the day
  * it went out and the day it came back. They are split here rather than
  * listed as spells, because "what happened on the 14th" is the question
  * being asked and a spell spanning three weeks answers it badly.
  *
  * Reads asset_assignments, which is the record itself — not a log written
  * alongside it. A log can disagree with the thing it describes; this
  * cannot.
  */
 app.get('/api/v1/assets/movements',{preHandler:guard('asset.read')},async req=>{
  const u=actor(req),{limit,offset,q}=page(req);
  const values:unknown[]=[u.orgId];
  const filters:string[]=['a.org_id=$1'];
  if(q.asset_id){values.push(q.asset_id);filters.push(`a.asset_id=$${values.length}::uuid`);}
  if(q.employee_id){
   values.push(q.employee_id);
   // Either end of a handover: the question "what has this person had" means
   // both what they took and what they gave back.
   filters.push(`(a.employee_id=$${values.length}::uuid OR a.returned_to_employee_id=$${values.length}::uuid)`);
  }
  if(q.project_id){values.push(q.project_id);filters.push(`a.project_id=$${values.length}::uuid`);}
  const where=filters.join(' AND ');

  const from=q.from?String(q.from):null, to=q.to?String(q.to):null;
  values.push(from,to,limit+1,offset);
  const iFrom=values.length-3,iTo=values.length-2,iLimit=values.length-1,iOffset=values.length;

  const rows=(await pool.query(
   `WITH moves AS (
      SELECT a.id AS allocation_id, a.asset_id, 'ISSUED' AS movement,
             a.issued_at AS at, a.employee_id AS to_employee_id,
             NULL::uuid AS from_employee_id, a.condition AS condition,
             a.condition AS condition_note_src, a.project_id, a.due_date,
             a.reason, a.created_by AS recorded_by
        FROM asset_assignments a WHERE ${where}
      UNION ALL
      SELECT a.id, a.asset_id, 'RETURNED',
             a.returned_at, a.returned_to_employee_id,
             a.employee_id, a.return_condition,
             a.return_condition_note, a.project_id, a.due_date,
             a.reason, a.received_by
        FROM asset_assignments a WHERE ${where} AND a.returned_at IS NOT NULL
    )
    SELECT m.*,
           s.asset_code, s.name AS asset_name, s.serial_number,
           (SELECT t.label FROM asset_types t WHERE t.id=s.asset_type_id) AS type_label,
           COALESCE(NULLIF(trim(concat_ws(' ', te.first_name, te.last_name)),''),te.emp_no) AS to_name,
           te.emp_no AS to_emp_no, te.phone AS to_phone,
           COALESCE(NULLIF(trim(concat_ws(' ', fe.first_name, fe.last_name)),''),fe.emp_no) AS from_name,
           fe.emp_no AS from_emp_no,
           p.name AS project_name, p.code AS project_code,
           ru.username AS recorded_by_username
      FROM moves m
      JOIN assets s ON s.id=m.asset_id
      LEFT JOIN employees te ON te.id=m.to_employee_id
      LEFT JOIN employees fe ON fe.id=m.from_employee_id
      LEFT JOIN projects p ON p.id=m.project_id
      LEFT JOIN users ru ON ru.id=m.recorded_by
     WHERE m.at IS NOT NULL
       AND ($${iFrom}::date IS NULL OR m.at >= $${iFrom}::date)
       AND ($${iTo}::date IS NULL OR m.at < ($${iTo}::date + 1))
     ORDER BY m.at DESC, m.allocation_id DESC
     LIMIT $${iLimit} OFFSET $${iOffset}`,values)).rows;

  return {
   data:rows.slice(0,limit).map(r=>({
    ...r,
    at:r.at instanceof Date?r.at.toISOString():r.at,
    due_date:r.due_date instanceof Date?r.due_date.toISOString().slice(0,10):r.due_date,
   })),
   has_more:rows.length>limit,
   next_offset:rows.length>limit?offset+limit:null,
  };
 });

 app.post('/api/v1/assets/assign-bulk',{preHandler:guard('asset.manage')},async(req,reply)=>{
  const u=actor(req),i=parse(assetBulkAssignSchema,req.body);
  await employeeAccess(pool,req,i.employee_id);
  if(i.project_id)await projectAccess(pool,req,i.project_id);
  const out=await mutate(pool,req,'asset.assign.bulk','asset',async db=>{
   const e=await inOrg(db,'employees',i.employee_id,u.orgId,true);
   if(e.status!=='ACTIVE')fail('EMPLOYEE_INACTIVE','Only active employees may receive assets');
   if(i.project_id){const p=await inOrg(db,'projects',i.project_id,u.orgId,true);if(p.status!=='ACTIVE')fail('PROJECT_INACTIVE','Project must be active');}

   const issued:string[]=[];const busy:Array<{asset_code:string;with_whom:string}>=[];
   for(const assetId of i.asset_ids){
    const asset=await inOrg(db,'assets',assetId,u.orgId,true);
    await assetAccess(req,assetId);
    const open=(await db.query(
     `SELECT COALESCE(NULLIF(trim(concat_ws(' ', emp.first_name, emp.last_name)),''),emp.emp_no) AS who
        FROM asset_assignments a JOIN employees emp ON emp.id=a.employee_id
       WHERE a.asset_id=$1 AND a.returned_at IS NULL`,[assetId])).rows[0];
    if(open){busy.push({asset_code:String(asset.asset_code),with_whom:String(open.who)});continue;}
    await db.query(
     `INSERT INTO asset_assignments(org_id,asset_id,employee_id,project_id,due_date,condition,reason,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
     [u.orgId,assetId,i.employee_id,i.project_id??null,i.due_date??null,i.condition,i.reason,u.id]);
    await db.query("UPDATE assets SET status='ASSIGNED',version=version+1,updated_at=now() WHERE id=$1",[assetId]);
    issued.push(assetId);
   }
   return {issued:issued.length,busy};
  });
  return reply.code(201).send(out);
 });

 app.post('/api/v1/assets/:id/transition',{preHandler:guard('asset.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,i=parse(assetTransitionSchema,req.body);
  return mutate(pool,req,'asset.transition','asset',async db=>{
   const row=await inOrg(db,'assets',id,u.orgId,true);await assetAccess(req,id);version(req,row as {version:number});
   const edges:Record<string,string[]>={AVAILABLE:['DAMAGED','LOST'],ASSIGNED:['IN_USE','RETURNED','DAMAGED','LOST'],IN_USE:['RETURNED','DAMAGED','LOST'],RETURNED:['AVAILABLE','DAMAGED'],DAMAGED:['AVAILABLE','WRITTEN_OFF'],LOST:['RETURNED','WRITTEN_OFF'],WRITTEN_OFF:[]};
   if(!edges[row.status]?.includes(i.status))fail('INVALID_TRANSITION',`Cannot move ${row.status} to ${i.status}`,409);
   /*
    * Closing the assignment records the *return*, and leaves the issue
    * condition alone.
    *
    * This used to overwrite `condition` -- the state the asset went out in --
    * with the state it came back in, so the register could never show that
    * something left in good order and returned needing repair. That is the
    * one comparison the whole record exists to support.
    *
    * The receiver is the acting user, and returned_to_employee_id names who
    * physically took it: a fault found next week otherwise has nobody to ask
    * but the person who handed it over.
    */
   if(['RETURNED','DAMAGED','LOST','WRITTEN_OFF'].includes(i.status))await db.query(
    `UPDATE asset_assignments
        SET returned_at=now(), return_condition=$2, return_condition_note=$3,
            received_by=$4, returned_to_employee_id=$5
      WHERE asset_id=$1 AND returned_at IS NULL`,
    [id,i.condition,i.condition_note??null,u.id,i.returned_to_employee_id??null]);
   return {...(await db.query('UPDATE assets SET status=$2,condition=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,i.status,i.condition])).rows[0],reason:i.reason,evidence_id:i.evidence_id};
  });
 });
 // Reading past audits is a read. The list already narrows to the reader's
 // own audits unless their scope is global, so asset.read is the right gate;
 // asset.manage locked the auditor out of the one register they exist to check.
 app.get('/api/v1/asset-audits',{preHandler:guard('asset.read')},async req=>{const {limit,offset}=page(req),u=actor(req),global=resolveScopes(u.scopes).global,rows=(await pool.query('SELECT * FROM asset_audits WHERE org_id=$1 AND ($4 OR created_by=$5) ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3',[u.orgId,limit+1,offset,global,u.id])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
 app.post('/api/v1/asset-audits',{preHandler:guard('asset.manage')},async(req,reply)=>{
  const i=parse(assetAuditSchema,req.body),u=actor(req);
  const result=await mutate(pool,req,'asset.audit','asset_audit',async db=>{
   const ids=[...new Set([...i.expected_ids,...i.scans.map(s=>s.asset_id)])],rows=await db.query('SELECT id,condition,asset_code FROM assets WHERE org_id=$1 AND id=ANY($2::uuid[])',[u.orgId,ids]);
   for(const id of ids)await assetAccess(req,id);
   if(rows.rowCount!==ids.length)fail('NOT_FOUND','Audit contains an unknown asset',404);
   if(new Set(i.scans.map(s=>s.asset_id)).size!==i.scans.length)fail('DUPLICATE_SCAN','Each asset may be scanned once per audit');
   const results=rows.rows.map(a=>{const scan=i.scans.find(s=>s.asset_id===a.id),expected=i.expected_ids.includes(a.id);return {asset_id:a.id,asset_code:a.asset_code,result:!scan?'MISSING':!expected?'UNEXPECTED':scan.condition!==a.condition?'CONDITION_CHANGED':'FOUND',expected_condition:a.condition,observed_condition:scan?.condition??null};});
   return (await db.query('INSERT INTO asset_audits(org_id,name,results,created_by) VALUES($1,$2,$3,$4) RETURNING *',[u.orgId,i.name,JSON.stringify(results),u.id])).rows[0];
  });return reply.code(201).send(result);
 });
}
