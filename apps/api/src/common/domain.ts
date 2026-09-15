import { createHash } from 'node:crypto';
import {inTransaction} from './transactionContext.js';
import {parseIfMatch} from './ifMatch.js';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError, toFieldErrors } from '@silverline/shared';
import type { z } from 'zod';
import { resolveScopes, taskScopeClause, employeeScopeClause } from './scopes.js';

export function parse<T>(schema:z.ZodType<T, z.ZodTypeDef, unknown>,body:unknown):T {
 const result=schema.safeParse(body);
 if(!result.success) throw new ApiError({status:422,code:'VALIDATION_ERROR',message:'Validation failed',fieldErrors:toFieldErrors(result.error)});
 return result.data;
}
export function fail(code:string,message:string,status=422):never {throw new ApiError({status,code,message});}
export function actor(req:FastifyRequest) {if(!req.authUser) fail('UNAUTHENTICATED','Sign in first',401);return req.authUser;}
export function version(req:FastifyRequest,row:{version:number}) {
 // Shared with the other seven modules so every route reads the header the
 // same way, weak validators and all.
 let n:number;
 try { n=parseIfMatch(req as unknown as {headers:Record<string,unknown>}); }
 catch { fail('VERSION_REQUIRED','If-Match must contain the current version'); }
 if(n!==row.version) fail('VERSION_CONFLICT','This record changed. Reload before editing.',409);
}
export function page(req:FastifyRequest) {
 const q=req.query as Record<string,string>;
 const limit=Math.min(100,Math.max(1,Number(q.limit)||30));
 const offset=Math.max(0,Number(q.offset)||0);
 if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset)) fail('VALIDATION_ERROR','Invalid pagination');
 return {limit,offset,q};
}
export async function inOrg(db:Pool|PoolClient,table:string,id:string,orgId:string,lock=false):Promise<Record<string,any>> {
 // Interpolated straight into SQL below, so this allow-list is the injection
 // guard, not a convenience. Every table a route passes here must be named.
 const allowed=['vendors','inventory_items','invoices','assets','employees','projects','tasks','cycles','automation_rules','webhook_subscriptions','custom_field_definitions','users',
  // Commercial spine (§6.3-6.5, §8).
  'clients','contacts','leads','opportunities','tenders','private_proposals','bank_guarantee_instruments','workspaces','party_gst_registrations',
  // Running-account billing (§15).
  'boq_items','ra_bills','project_advances',
  // Approvals (§41).
  'approval_policies','approval_instances','approval_delegations',
  // Procurement (§13).
  'purchase_requisitions','purchase_orders','goods_receipt_notes',
  // §43 enhancements.
  'rfqs','vendor_quotes','vendor_returns',
  // Expenses and project cost control (§15.6, §16).
  'cost_heads','expense_policies','expense_claims',
  // Financial control (§45).
  'financial_periods','payments','bank_transactions',
  // Inventory control (§44).
  'stock_locations','stock_reservations','stock_counts',
  // Workforce allocation (§47).
  'resource_allocations','work_shifts','roster_entries',
  // Project masters (§6.2).
  'project_categories','project_types',
  // Payables and receivables (§58).
  'payment_runs','documents','document_types'];
 // The allow-list is the injection guard for the interpolated table name
 // below, not a convenience — every table a route passes here must be named.
 // Naming the table in the error turns a bare 500 into a one-line fix; this
 // has cost several debugging sessions.
 if(!allowed.includes(table)) throw new Error(`inOrg: '${table}' is not in the allowed table list in common/domain.ts`);
 const r=await db.query(`SELECT * FROM ${table} WHERE id=$1 AND org_id=$2${lock?' FOR UPDATE':''}`,[id,orgId]);
 if(!r.rowCount) fail('NOT_FOUND','Record not found',404);
 return r.rows[0];
}
export async function projectAccess(pool:Pool,req:FastifyRequest,id:string) {
 const u=actor(req);await inOrg(pool,'projects',id,u.orgId);
 const scopes=resolveScopes(u.scopes);
 if(scopes.global||scopes.projects.includes(id)) return;
 const values:unknown[]=[id,u.orgId];
 const clause=await taskScopeClause(pool,u.orgId,scopes,values);
 const r=await pool.query(`SELECT 1 FROM tasks WHERE project_id=$1 AND org_id=$2 AND ${clause} LIMIT 1`,values);
 if(!r.rowCount) fail('FORBIDDEN','Project outside your scope',403);
}
export async function employeeAccess(pool:Pool,req:FastifyRequest,id:string) {
 const u=actor(req),scopes=resolveScopes(u.scopes);if(scopes.global)return;
 const values:unknown[]=[id,u.orgId],clause=await employeeScopeClause(pool,u.orgId,scopes,values);
 const r=await pool.query(`SELECT 1 FROM employees WHERE id=$1 AND org_id=$2 AND ${clause}`,values);
 if(!r.rowCount)fail('FORBIDDEN','Employee outside your scope',403);
}
/** Serialize matching retries; commit business mutation, receipt, audit and event atomically. */
export async function mutate<T>(pool:Pool,req:FastifyRequest,action:string,entity:string,fn:(db:PoolClient)=>Promise<T>):Promise<T> {
 const u=actor(req),key=String(req.headers['idempotency-key']??'');
 if(key.length>255)fail('INVALID_IDEMPOTENCY_KEY','Idempotency key is too long');
 const hash=createHash('sha256').update(JSON.stringify({method:req.method,url:req.url,body:req.body??null})).digest('hex');
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  if(key){
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${u.id}:${key}`]);
   const prior=await db.query('SELECT * FROM v2_operations WHERE user_id=$1 AND key=$2',[u.id,key]);
   if(prior.rowCount){if(prior.rows[0].request_hash!==hash)fail('IDEMPOTENCY_CONFLICT','Key was already used for another request',409);await db.query('COMMIT');return prior.rows[0].response as T;}
  }
  const value=await inTransaction(pool,db,()=>fn(db));
  const object=value as Record<string,unknown>;
  const id=typeof object?.id==='string'?object.id:null;
  // Secrets and personal records are never copied into event payloads.
  const safe=entity==='user'||entity==='webhook'||entity==='settings'?{id}:value;
  await db.query('INSERT INTO audit_events(org_id,actor_id,action,entity_type,entity_id,after_state,request_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[u.orgId,u.id,action,entity,id,JSON.stringify(safe),req.requestId,key||null]);
  if(key)await db.query('INSERT INTO v2_operations(key,user_id,path,request_hash,response) VALUES($1,$2,$3,$4,$5)',[key,u.id,req.url,hash,JSON.stringify(value)]);
  await db.query('COMMIT');return value;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
