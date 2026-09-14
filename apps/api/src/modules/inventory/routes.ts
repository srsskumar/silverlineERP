import {resolveScopes,employeeScopeClause} from '../../common/scopes.js';
import {scopedReads} from "../../common/scopedReads.js";
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { vendorSchema,itemSchema,stockSchema,invoiceSchema,assetSchema,assetAssignSchema,assetTransitionSchema,assetAuditSchema } from '@silverline/shared';
import { buildAuthenticate,requirePermission,scopesForPermission } from '../../common/auth.js';
import { actor,parse,page,inOrg,mutate,version,fail,projectAccess,employeeAccess } from '../../common/domain.js';

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

 for(const [path,table,schema,permission] of [
  ['vendors','vendors',vendorSchema,'inventory'],['inventory/items','inventory_items',itemSchema,'inventory'],['assets','assets',assetSchema,'asset'],
 ] as const) {
  app.get(`/api/v1/${path}`,{preHandler:guard(`${permission}.read`)},async req=>{
   const u=actor(req),{limit,offset,q}=page(req),values:unknown[]=[u.orgId,limit+1,offset];
   let where='a.org_id=$1';
   if(q.search){values.push(`%${q.search}%`);where+=` AND (a.name ILIKE $${values.length} OR ${table==='assets'?'a.asset_code':'a.code'} ILIKE $${values.length})`;}
   if(table==='assets')where+=` AND ${await assetClause(req,values,'a.id')}`;
   const extra=table==='inventory_items'?",COALESCE((SELECT sum(CASE WHEN direction='IN' THEN quantity ELSE -quantity END) FROM stock_transactions WHERE item_id=a.id),0)::text AS available":'';
   const rows=await pool.query(`SELECT a.*${extra} FROM ${table} a WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3`,values);
   return {data:rows.rows.slice(0,limit),has_more:rows.rows.length>limit,next_offset:rows.rows.length>limit?offset+limit:null};
  });
  app.post(`/api/v1/${path}`,{preHandler:guard(`${permission}.manage`)},async(req,reply)=>{
   const input=parse(schema as any,req.body) as Record<string,unknown>,u=actor(req);
   const row=await mutate(pool,req,`${permission}.create`,table,async db=>{
    if(input.vendor_id)await inOrg(db,'vendors',String(input.vendor_id),u.orgId);
    const keys=Object.keys(input),values=[u.orgId,u.id,...Object.values(input)];
    const r=await db.query(`INSERT INTO ${table}(org_id,created_by,${keys.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,values);return r.rows[0];
   });return reply.code(201).send(row);
  });
  app.patch(`/api/v1/${path}/:id`,{preHandler:guard(`${permission}.manage`)},async req=>{
   const input=parse(schema as any,req.body) as Record<string,unknown>,u=actor(req),id=(req.params as {id:string}).id;
   return mutate(pool,req,`${permission}.update`,table,async db=>{
    const old=await inOrg(db,table,id,u.orgId,true);if(table==='assets')await assetAccess(req,id);version(req,old as {version:number});
    if(input.vendor_id)await inOrg(db,'vendors',String(input.vendor_id),u.orgId);
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
   const check=await db.query(`SELECT COALESCE(sum(CASE WHEN direction='IN' THEN quantity ELSE -quantity END),0) >= $2::numeric AS enough FROM stock_transactions WHERE item_id=$1`,[input.item_id,input.quantity]);
   if(input.direction==='OUT'&&!check.rows[0].enough)fail('INSUFFICIENT_STOCK','Posting would make available stock negative',409);
   const r=await db.query('INSERT INTO stock_transactions(org_id,item_id,direction,quantity,reference,project_id,invoice_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[u.orgId,input.item_id,input.direction,input.quantity,input.reference,input.project_id??null,input.invoice_id??null,input.reason??null,u.id]);
   const stock=await db.query(`SELECT COALESCE(sum(CASE WHEN direction='IN' THEN quantity ELSE -quantity END),0)::text AS available FROM stock_transactions WHERE item_id=$1`,[input.item_id]);
   const low=Number(stock.rows[0].available)<=Number(item.low_stock_threshold);
   // $1 and $2 carry explicit casts: a bare parameter in an INSERT ... SELECT
   // list is inferred from the select expression, not the target column, so
   // reusing $1 in the uuid-typed WHERE made Postgres deduce two different
   // types for it and reject the statement (42P08). Every OUT posting that
   // reached the low-stock threshold failed with a 500 because of it.
   if(low&&input.direction==='OUT')await db.query("INSERT INTO notifications(org_id,recipient_id,type,title,body,entity_type,entity_id,event_key) SELECT DISTINCT $1::uuid,u.id,'LOW_STOCK','Stock needs replenishment','Open Inventory to review stock levels','inventory_item',$2::uuid,$3::text FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE u.org_id=$1 AND u.auth_status='ACTIVE' AND rp.permission_code='inventory.manage' ON CONFLICT DO NOTHING",[u.orgId,item.id,`low-stock:${r.rows[0].id}`]);
   return {...r.rows[0],available:stock.rows[0].available,low_stock:low};
  });return reply.code(201).send(row);
 });
 app.get('/api/v1/invoices',{preHandler:guard('inventory.read')},async req=>{const {limit,offset}=page(req),rows=(await pool.query('SELECT * FROM invoices WHERE org_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',[actor(req).orgId,limit+1,offset])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
 app.post('/api/v1/invoices',{preHandler:guard('inventory.manage')},async(req,reply)=>{
  const i=parse(invoiceSchema,req.body),u=actor(req);
  const row=await mutate(pool,req,'invoice.create','invoice',async db=>{
   await inOrg(db,'vendors',i.vendor_id,u.orgId);
   if(Number(i.gst_rate)>100)fail('VALIDATION_ERROR','Tax rate must be between zero and 100');
   const r=await db.query(`INSERT INTO invoices(org_id,serial_number,vendor_id,hsn,gst_enabled,gst_rate,subtotal,tax,total,payment_mode,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,round(CASE WHEN $5 THEN $7::numeric*$6::numeric/100 ELSE 0 END,2),$7::numeric+round(CASE WHEN $5 THEN $7::numeric*$6::numeric/100 ELSE 0 END,2),$8,$9,$10) RETURNING *`,[u.orgId,i.serial_number,i.vendor_id,i.hsn,i.gst_enabled,i.gst_rate,i.subtotal,i.payment_mode,i.reference,u.id]);return r.rows[0];
  });return reply.code(201).send(row);
 });
 app.get('/api/v1/assets/resolve',{preHandler:guard('asset.read')},async req=>{
  const u=actor(req),q=req.query as {code:string};
  const row=await pool.query('SELECT id FROM assets WHERE org_id=$1 AND (asset_code=$2 OR serial_number=$2)',[u.orgId,q.code]);
  if(!row.rowCount)fail('NOT_FOUND','No asset matches this code',404);
  await assetAccess(req,row.rows[0].id);return {id:row.rows[0].id};
 });
 app.get('/api/v1/assets/:id',{preHandler:guard('asset.read')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,row=await inOrg(pool,'assets',id,u.orgId);
  const assignments=await pool.query('SELECT * FROM asset_assignments WHERE asset_id=$1 ORDER BY issued_at DESC LIMIT 100',[id]);
  await assetAccess(req,id);return {...row,assignments:assignments.rows};
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
 app.post('/api/v1/assets/:id/transition',{preHandler:guard('asset.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id,i=parse(assetTransitionSchema,req.body);
  return mutate(pool,req,'asset.transition','asset',async db=>{
   const row=await inOrg(db,'assets',id,u.orgId,true);await assetAccess(req,id);version(req,row as {version:number});
   const edges:Record<string,string[]>={AVAILABLE:['DAMAGED','LOST'],ASSIGNED:['IN_USE','RETURNED','DAMAGED','LOST'],IN_USE:['RETURNED','DAMAGED','LOST'],RETURNED:['AVAILABLE','DAMAGED'],DAMAGED:['AVAILABLE','WRITTEN_OFF'],LOST:['RETURNED','WRITTEN_OFF'],WRITTEN_OFF:[]};
   if(!edges[row.status]?.includes(i.status))fail('INVALID_TRANSITION',`Cannot move ${row.status} to ${i.status}`,409);
   if(['RETURNED','DAMAGED','LOST','WRITTEN_OFF'].includes(i.status))await db.query('UPDATE asset_assignments SET returned_at=now(),condition=$2 WHERE asset_id=$1 AND returned_at IS NULL',[id,i.condition]);
   return {...(await db.query('UPDATE assets SET status=$2,condition=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,i.status,i.condition])).rows[0],reason:i.reason,evidence_id:i.evidence_id};
  });
 });
 app.get('/api/v1/asset-audits',{preHandler:guard('asset.manage')},async req=>{const {limit,offset}=page(req),u=actor(req),global=resolveScopes(u.scopes).global,rows=(await pool.query('SELECT * FROM asset_audits WHERE org_id=$1 AND ($4 OR created_by=$5) ORDER BY created_at DESC LIMIT $2 OFFSET $3',[u.orgId,limit+1,offset,global,u.id])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
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
